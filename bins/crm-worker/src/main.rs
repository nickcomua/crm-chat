//! crm-worker — Restate-based Telegram integration service.
//!
//! This service replaces telegram-subscriber with durable workflows powered by
//! Restate. It runs two concurrent subsystems:
//!
//! 1. **Restate HTTP server** — hosts the PhoneAuthWorkflow, QrAuthWorkflow,
//!    and ClientScanner virtual object handlers
//! 2. **Convex subscription bridge** — subscribes to Convex queries for pending
//!    auth sessions and connected clients, dispatching to Restate via HTTP ingress

mod auth;
mod client_pool;
mod config;
mod convex_bridge;
mod error;
mod ops;
mod services;

use std::env;
use std::sync::Arc;
use std::time::Duration;

use restate_sdk::prelude::*;
use tracing::info;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

use crate::client_pool::ClientPool;
use crate::config::WorkerConfig;
use crate::services::chat_scanner::{ChatScanner, ChatScannerImpl};
use crate::services::client_scanner::{ClientScanner, ClientScannerImpl};
use crate::services::dialog_sync::{DialogSync, DialogSyncImpl};
use crate::services::media_downloader::{MediaDownloader, MediaDownloaderImpl};
use crate::services::phone_auth::{PhoneAuthWorkflow, PhoneAuthWorkflowImpl};
use crate::services::profile_photo_sync::{ProfilePhotoSync, ProfilePhotoSyncImpl};
use crate::services::qr_auth::{QrAuthWorkflow, QrAuthWorkflowImpl};
use crate::services::update_listener::{UpdateListener, UpdateListenerImpl};

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

    // Shared Telegram client pool — process-local cache of TCP connections
    let pool = Arc::new(ClientPool::new(config.api_id, config.api_hash.clone()));

    // Mint JWT and create Convex client for Restate handlers
    let token = auth::mint_worker_jwt(&config.private_key, &config.robot_id, &config.robot_kid)?;
    let mut raw_client = ::convex::ConvexClient::new(&config.convex_url).await?;
    raw_client.set_auth(Some(token)).await;
    let convex_client = convex_backend::ConvexApiClient::new(raw_client);

    // Build Restate endpoint with all service handlers
    // `.serve()` wraps each impl in the macro-generated type that implements Discoverable
    let endpoint = Endpoint::builder()
        .bind(
            PhoneAuthWorkflowImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .bind(
            QrAuthWorkflowImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .bind(
            ClientScannerImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .bind(
            DialogSyncImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .bind(
            ProfilePhotoSyncImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .bind(
            ChatScannerImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .bind(
            MediaDownloaderImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .bind(
            UpdateListenerImpl {
                convex: convex_client.clone(),
                pool: pool.clone(),
            }
            .serve(),
        )
        .build();

    let restate_port = config.restate_port;

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

    // Spawn the Convex subscription bridge
    let bridge_config = config.clone();
    let bridge_handle = tokio::spawn(async move {
        if let Err(e) = convex_bridge::run(&bridge_config).await {
            tracing::error!(error = %e, "Convex bridge failed");
        }
    });

    info!(
        restate_port,
        "crm-worker ready. Restate server + Convex bridge running."
    );

    // Wait for either subsystem to exit
    tokio::select! {
        result = restate_handle => {
            match result {
                Ok(()) => info!("Restate server exited"),
                Err(e) => tracing::error!(error = %e, "Restate server task panicked"),
            }
        }
        _ = bridge_handle => {
            info!("Convex bridge exited");
        }
    }

    Ok(())
}

/// Register this service endpoint with the Restate admin API.
///
/// Panics if registration fails — without it, all Restate handler invocations
/// will 404 and the worker is non-functional.
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

    let response = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .unwrap_or_else(|e| {
            panic!(
                "Failed to connect to Restate admin API at {}: {e}. \
                 Is the Restate server running? (docker compose up -d)",
                config.restate_admin_url
            )
        });

    if response.status().is_success() {
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
            "Deployment registered with Restate"
        );
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        panic!(
            "Failed to register deployment with Restate (HTTP {status}): {body}. \
             Admin URL: {}, Service URL: {}",
            config.restate_admin_url, config.restate_service_url
        );
    }
}
