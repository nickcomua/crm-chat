//! crm-worker — Restate-based Telegram integration service.
//!
//! Leaf services (DialogSync, ChatScanner, etc.) are Restate virtual objects
//! and workflows with full durable execution. The TaskOrchestrator runs as a
//! plain tokio task that subscribes to Convex queries and dispatches work to
//! leaf services via HTTP POST to the Restate ingress endpoint — zero journal
//! noise.

mod auth;
mod config;
mod error;
mod ops;
mod services;
pub mod session_manager;

use std::env;
use std::sync::Arc;
use std::time::Duration;

use restate_sdk::prelude::*;
use tokio_util::sync::CancellationToken;
use tracing::info;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

use crate::config::WorkerConfig;
use crate::services::chat_scanner::{ChatScanner, ChatScannerImpl};
use crate::services::dialog_sync::{DialogSync, DialogSyncImpl};
use crate::services::media_downloader::{MediaDownloader, MediaDownloaderImpl};
use crate::services::phone_auth::{PhoneAuthWorkflow, PhoneAuthWorkflowImpl};
use crate::services::profile_photo_sync::{ProfilePhotoSync, ProfilePhotoSyncImpl};
use crate::services::qr_auth::{QrAuthWorkflow, QrAuthWorkflowImpl};
use crate::services::task_orchestrator::run_orchestrator;
use crate::services::update_listener::{UpdateListener, UpdateListenerImpl};
use crate::session_manager::TelegramSessionManager;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize Sentry (if SENTRY_URL is set)
    let _guard = env::var("SENTRY_URL").ok().map(|dsn| {
        sentry::init((
            dsn,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                traces_sample_rate: 1.0,
                ..Default::default()
            },
        ))
    });

    // Initialize tracing
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,crm_worker=debug"));

    let file_appender = tracing_appender::rolling::hourly("logs", "crm-worker.log");
    let (non_blocking, _file_guard) = tracing_appender::non_blocking(file_appender);

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(non_blocking),
        )
        .with(sentry_tracing::layer());

    tracing::subscriber::set_global_default(subscriber)?;

    info!("Starting crm-worker");

    let config = WorkerConfig::from_env()?;

    // Unified session manager — handles session files, client caching, discovery
    let sessions = Arc::new(TelegramSessionManager::new(
        config.api_id,
        config.api_hash.clone(),
    ));

    // Fetch Clerk M2M JWT and create Convex client for Restate handlers
    let http_for_auth = reqwest::Client::new();
    let token = auth::fetch_m2m_jwt(&http_for_auth, &config.m2m_secret_key).await?;
    let mut raw_client = ::convex::ConvexClient::new(&config.convex_url).await?;
    raw_client.set_auth(Some(token)).await;
    let convex_client = convex_backend::ConvexApiClient::new(raw_client);

    // Build Restate endpoint with leaf service handlers (no TaskOrchestrator —
    // it runs as a plain tokio task to avoid journal noise)
    let endpoint = Endpoint::builder()
        .bind(
            PhoneAuthWorkflowImpl {
                convex: convex_client.clone(),
                sessions: sessions.clone(),
            }
            .serve(),
        )
        .bind(
            QrAuthWorkflowImpl {
                convex: convex_client.clone(),
                sessions: sessions.clone(),
            }
            .serve(),
        )
        .bind(
            DialogSyncImpl {
                convex: convex_client.clone(),
                sessions: sessions.clone(),
            }
            .serve(),
        )
        .bind(
            ProfilePhotoSyncImpl {
                convex: convex_client.clone(),
                sessions: sessions.clone(),
            }
            .serve(),
        )
        .bind(
            ChatScannerImpl {
                convex: convex_client.clone(),
                sessions: sessions.clone(),
            }
            .serve(),
        )
        .bind(
            MediaDownloaderImpl {
                convex: convex_client.clone(),
                sessions: sessions.clone(),
            }
            .serve(),
        )
        .bind(
            UpdateListenerImpl {
                convex: convex_client.clone(),
                sessions: sessions.clone(),
            }
            .serve(),
        )
        .build();

    let restate_port = config.restate_port;
    let ingress_url = config.restate_ingress_url.clone();

    // Spawn the Restate HTTP server
    let restate_handle = tokio::spawn(async move {
        info!(port = restate_port, "Starting Restate HTTP server");
        HttpServer::new(endpoint)
            .listen_and_serve(
                format!("0.0.0.0:{restate_port}")
                    .parse::<std::net::SocketAddr>()
                    .unwrap(),
            )
            .await;
    });

    // Wait briefly for the HTTP server to bind, then register with Restate
    tokio::time::sleep(Duration::from_millis(500)).await;
    register_deployment(&config).await;

    // Spawn the orchestrator as a plain tokio task — dispatches to Restate
    // leaf services via HTTP ingress, zero journal entries
    let orch_convex = convex_client.clone();
    let orch_config = config.clone();
    let orch_sessions = sessions.clone();
    let orch_ingress = ingress_url.clone();
    let orch_cancel = CancellationToken::new();
    let orchestrator_handle = tokio::spawn(async move {
        if let Err(e) = run_orchestrator(
            &orch_convex,
            &orch_config,
            &orch_sessions,
            &orch_ingress,
            &orch_cancel,
        )
        .await
        {
            tracing::error!(error = %e, "TaskOrchestrator exited with error");
        }
    });

    info!(restate_port, "crm-worker ready. All services registered.");

    // Wait for either server to exit
    tokio::select! {
        result = restate_handle => {
            match result {
                Ok(()) => info!("Restate server exited"),
                Err(e) => tracing::error!(error = %e, "Restate server task panicked"),
            }
        }
        result = orchestrator_handle => {
            match result {
                Ok(()) => info!("Orchestrator exited"),
                Err(e) => tracing::error!(error = %e, "Orchestrator task panicked"),
            }
        }
    }

    Ok(())
}

/// Register this service endpoint with the Restate admin API.
///
/// Retries up to 30 times (1s apart) until the admin API is reachable,
/// then panics if registration fails — without it, all Restate handler
/// invocations will 404 and the worker is non-functional.
async fn register_deployment(config: &WorkerConfig) {
    let http = reqwest::Client::new();
    let url = format!("{}/deployments", config.restate_admin_url);

    info!(
        admin_url = %config.restate_admin_url,
        service_url = %config.restate_service_url,
        "Registering deployment with Restate"
    );

    let body = serde_json::json!({
        "uri": config.restate_service_url,
        "force": true,
    });

    // Retry loop — Restate may still be starting up (especially in test/CI)
    let mut last_error = String::new();
    for attempt in 1..=30 {
        match http.post(&url).json(&body).send().await {
            Ok(response) if response.status().is_success() => {
                let result: serde_json::Value = response.json().await.unwrap_or_default();
                let services: Vec<String> = result["services"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s["name"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                info!(
                    services = ?services,
                    attempt,
                    "Deployment registered with Restate"
                );
                return;
            }
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                last_error = format!("HTTP {status}: {body}");
            }
            Err(e) => {
                last_error = e.to_string();
            }
        }

        if attempt < 30 {
            tracing::debug!(
                attempt,
                error = %last_error,
                "Restate admin not ready, retrying in 1s"
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    panic!(
        "Failed to register deployment with Restate after 30 attempts: {last_error}. \
         Admin URL: {}, Service URL: {}",
        config.restate_admin_url, config.restate_service_url
    );
}
