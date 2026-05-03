//! crm-worker — Convex-driven Telegram integration service.
//!
//! The worker runs a handful of independent `Job`s. Each job subscribes to a
//! Convex query that yields the current set of entity IDs needing work
//! (e.g. clients with `phase = NeedsSync`, chats with `scanPhase = Queued`,
//! media with `status = Pending`) and spawns a per-entity tokio task. When
//! an entity leaves the set the task is aborted. No Restate, no ingress,
//! no HTTP endpoint — Convex *is* the queue and the source of truth.

mod auth;
mod config;
mod error;
mod job;
mod jobs;
mod ops;
mod runner;
pub mod secrets;
pub mod session_manager;

use std::sync::Arc;
use std::time::Duration;

use convex_backend::{ClientsWorkerMarkSessionErrorArgs, ClientsWorkerRegisterConnectedArgs};
use messanger_interface::MessengerClient;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

use crate::config::WorkerConfig;
use crate::error::WorkerError;
use crate::job::{Job, JobCtx};
use crate::jobs::chat_scanner::ChatScannerJob;
use crate::jobs::dialog_sync::DialogSyncJob;
use crate::jobs::media_downloader::MediaDownloaderJob;
use crate::jobs::phone_auth::PhoneAuthJob;
use crate::jobs::qr_auth::QrAuthJob;
use crate::jobs::update_listener::UpdateListenerJob;
use crate::ops::convex::ConvexApi;
use crate::runner::run_job;
use crate::session_manager::{SessionManager, TelegramSessionManager};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _sentry = init_sentry();
    init_tracing();

    info!("starting crm-worker");

    let config = WorkerConfig::from_env()?;
    let sessions = Arc::new(TelegramSessionManager::new(
        config.api_id,
        config.api_hash.clone(),
    ));

    let http_for_auth = reqwest::Client::new();
    let token = auth::fetch_m2m_jwt(&http_for_auth, &config.m2m_secret_key).await?;
    let mut raw = ::convex::ConvexClient::new(&config.convex_url).await?;
    raw.set_auth(Some(token)).await;
    let convex = convex_backend::ConvexApiClient::new(raw);

    let ctx = Arc::new(JobCtx {
        convex,
        sessions: sessions.clone(),
        config: config.clone(),
    });

    // One-shot startup housekeeping.
    sessions.cleanup_temp_sessions();
    discover_and_register_sessions(&ctx).await;

    // Background JWT refresh.
    tokio::spawn(jwt_refresh_loop(ctx.clone()));

    // Spawn every job runner. Each owns its own subscription and per-entity tasks.
    let jobs: Vec<Arc<dyn Job>> = vec![
        Arc::new(DialogSyncJob),
        Arc::new(UpdateListenerJob),
        Arc::new(ChatScannerJob),
        Arc::new(MediaDownloaderJob::new()),
        Arc::new(PhoneAuthJob),
        Arc::new(QrAuthJob),
    ];
    let handles: Vec<_> = jobs
        .into_iter()
        .map(|j| tokio::spawn(run_job(j, ctx.clone())))
        .collect();

    info!(job_count = handles.len(), "crm-worker ready");

    // If any job runner exits, the worker exits. systemd / docker will restart.
    let (_result, _idx, _remaining) = futures::future::select_all(handles).await;
    warn!("a job runner exited — shutting down");
    Ok(())
}

fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,crm_worker=debug"));
    let fmt = tracing_subscriber::fmt::layer();
    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt)
        .with(sentry_tracing::layer())
        .init();
}

fn init_sentry() -> Option<sentry::ClientInitGuard> {
    let dsn = secrets::SecretSpec::builder()
        .with_profile("crm_worker")
        .load()
        .ok()?
        .secrets
        .sentry_url?;
    Some(sentry::init((
        dsn,
        sentry::ClientOptions {
            release: sentry::release_name!(),
            traces_sample_rate: 1.0,
            ..Default::default()
        },
    )))
}

async fn jwt_refresh_loop(ctx: Arc<JobCtx>) {
    let http = reqwest::Client::new();
    let mut interval = tokio::time::interval(Duration::from_secs(50 * 60));
    interval.tick().await; // consume initial immediate tick
    loop {
        interval.tick().await;
        match auth::fetch_m2m_jwt(&http, &ctx.config.m2m_secret_key).await {
            Ok(new_token) => {
                let mut handle = ctx.convex.inner().clone();
                handle.set_auth(Some(new_token)).await;
                info!("JWT refreshed");
            }
            Err(e) => warn!(error = %e, "JWT refresh failed"),
        }
    }
}

/// Look for `.session` files on disk and register each authorized one with
/// Convex as a connected client. Removes orphan sessions whose owner has
/// deleted the client (tombstone check).
///
/// Uses the session manager's client cache so the same TelegramClient is
/// reused by subsequent jobs (UpdateListener, ChatScanner, etc.) instead
/// of building standalone clients that race on the same session file.
async fn discover_and_register_sessions(ctx: &JobCtx) {
    let discovered = ctx.sessions.discover_sessions();
    if discovered.is_empty() {
        info!("no existing session files");
        return;
    }
    info!(count = discovered.len(), "checking sessions");

    let mut registered = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;

    for (owner_id, telegram_id) in &discovered {
        let tg = match ctx
            .sessions
            .get_for_telegram_id(owner_id, telegram_id)
            .await
        {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    owner = %owner_id,
                    telegram_id = %telegram_id,
                    error = %e,
                    "failed to build client for session"
                );
                failed += 1;
                continue;
            }
        };

        match tg.is_authorized().await {
            Ok(true) => {}
            Ok(false) => {
                warn!(
                    owner = %owner_id,
                    telegram_id = %telegram_id,
                    "session not authorized — marking client as error"
                );
                if let Err(e) = ctx
                    .convex
                    .clients_worker_mark_session_error(ClientsWorkerMarkSessionErrorArgs {
                        userId: owner_id.clone(),
                        telegramId: telegram_id.clone(),
                        message: "Telegram session is no longer authorized. Re-login required."
                            .to_string(),
                    })
                    .await
                {
                    warn!(error = %e, "failed to mark client session error in Convex");
                }
                skipped += 1;
                continue;
            }
            Err(e) => {
                warn!(
                    owner = %owner_id,
                    telegram_id = %telegram_id,
                    error = %e,
                    "is_authorized check failed"
                );
                if let Err(e) = ctx
                    .convex
                    .clients_worker_mark_session_error(ClientsWorkerMarkSessionErrorArgs {
                        userId: owner_id.clone(),
                        telegramId: telegram_id.clone(),
                        message: format!("Authorization check failed: {e}"),
                    })
                    .await
                {
                    warn!(error = %e, "failed to mark client session error in Convex");
                }
                failed += 1;
                continue;
            }
        }

        let external_id = match tg.get_client_external_id().await {
            Ok(id) => id,
            Err(e) => {
                warn!(
                    owner = %owner_id,
                    telegram_id = %telegram_id,
                    error = %e,
                    "get external id failed"
                );
                failed += 1;
                continue;
            }
        };

        let numeric_id = tg.get_numeric_external_id().await.ok();
        let phone_number = tg.get_phone_number().await;

        match ctx
            .convex
            .clients_worker_register_connected(ClientsWorkerRegisterConnectedArgs {
                userId: owner_id.clone(),
                telegramId: external_id.clone(),
                externalId: numeric_id,
                kind: "Telegram".to_string(),
                phoneNumber: phone_number,
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))
        {
            Ok(Some(client_id)) => {
                registered += 1;
                info!(client_id, external_id = %external_id, owner = %owner_id, "registered session");
            }
            Ok(None) => {
                info!(
                    external_id = %external_id,
                    owner = %owner_id,
                    telegram_id = %telegram_id,
                    "session blocked by tombstone — removing orphan"
                );
                ctx.sessions.remove_session_file(owner_id, telegram_id);
                skipped += 1;
            }
            Err(e) => {
                warn!(external_id = %external_id, owner = %owner_id, error = %e, "register failed");
                failed += 1;
            }
        }
    }

    info!(registered, skipped, failed, "session discovery complete");
}
