//! TaskOrchestrator — dumb pipe that subscribes to the `workerTasks` table and
//! dispatches each pending task to Restate via HTTP ingress.
//!
//! ALL orchestration logic lives in Convex mutations. This module:
//! 1. Subscribes to `workerTasks.pendingForWorker`
//! 2. For each pending task: marks it Dispatched → POSTs to Restate
//! 3. Refreshes JWTs on a timer
//!
//! Zero business logic. Zero in-memory state.

use std::time::Duration;

use convex_backend::{
    ClientsWorkerRegisterConnectedArgs, ConvexApi, ConvexApiClient,
    WorkerTasksMarkDispatchedArgs, WorkerTasksPendingForWorkerArgs, WorkerTasksTable,
    WorkerTasksTask as Task,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::auth::mint_worker_jwt;
use crate::config::{WorkerConfig, discover_session_files};
use crate::ops::convex::ConvexResultExt as _;

/// Fire-and-forget dispatch to a Restate service handler via HTTP ingress.
///
/// Takes a raw JSON string payload (already serialized in Convex) to avoid
/// double-serialization.
async fn restate_send_raw(
    http: &reqwest::Client,
    ingress_url: &str,
    service: &str,
    key: &str,
    handler: &str,
    json_payload: &str,
) {
    let url = format!("{ingress_url}/{service}/{key}/{handler}/send");
    match http
        .post(&url)
        .header("Content-Type", "application/json")
        .body(json_payload.to_owned())
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            debug!(service, key, handler, "Dispatched to Restate");
        }
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            warn!(service, key, handler, %status, body = %text, "Restate dispatch failed");
        }
        Err(e) => {
            warn!(service, key, handler, error = %e, "Restate dispatch error");
        }
    }
}

/// Fire-and-forget dispatch to a Restate handler that takes no arguments.
async fn restate_send_empty(
    http: &reqwest::Client,
    ingress_url: &str,
    service: &str,
    key: &str,
    handler: &str,
) {
    let url = format!("{ingress_url}/{service}/{key}/{handler}/send");
    match http.post(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            debug!(service, key, handler, "Dispatched to Restate (no args)");
        }
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            warn!(service, key, handler, %status, body = %text, "Restate dispatch failed");
        }
        Err(e) => {
            warn!(service, key, handler, error = %e, "Restate dispatch error");
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Main orchestration loop (plain async — NOT a Restate handler)
// ────────────────────────────────────────────────────────────────────────────

/// Run the orchestrator loop. Call from a tokio task in main.rs.
pub async fn run_orchestrator(
    convex: &ConvexApiClient,
    config: &WorkerConfig,
    ingress_url: &str,
    token: &CancellationToken,
) -> Result<(), anyhow::Error> {
    info!("TaskOrchestrator: discovering sessions");
    discover_and_register_sessions(convex, config).await;

    // // Reset stale Dispatched tasks from a previous run so they get re-dispatched.
    // // Restate deduplicates by virtual-object key, so double-dispatch is harmless.
    // match convex.worker_tasks_reset_dispatched().await {
    //     Ok(n) => {
    //         if n > 0.0 {
    //             info!(count = n, "Reset stale dispatched tasks to Pending");
    //         }
    //     }
    //     Err(e) => warn!(error = %e, "Failed to reset dispatched tasks"),
    // }

    let http = reqwest::Client::new();

    // Single subscription: all pending worker tasks (with media workflow limit)
    let max_media = if config.max_media_workflows > 0 {
        Some(config.max_media_workflows as f64)
    } else {
        None
    };
    info!(max_media_workflows = config.max_media_workflows, "Media workflow concurrency limit");
    let mut tasks = convex
        .subscribe_worker_tasks_pending_for_worker(WorkerTasksPendingForWorkerArgs {
            maxMediaWorkflows: max_media,
        })
        .await?;

    // JWT refresh timer (every 50 minutes)
    let mut jwt_refresh = tokio::time::interval(Duration::from_secs(50 * 60));
    jwt_refresh.tick().await;

    info!("TaskOrchestrator: entering subscription loop");

    loop {
        tokio::select! {
            biased;

            // ── Cancellation ────────────────────────────────────────────
            _ = token.cancelled() => {
                info!("TaskOrchestrator: cancelled");
                return Ok(());
            }

            // ── JWT refresh ─────────────────────────────────────────────
            _ = jwt_refresh.tick() => {
                match mint_worker_jwt(&config.private_key, &config.robot_id, &config.robot_kid) {
                    Ok(new_token) => {
                        let mut auth_handle = convex.inner().clone();
                        auth_handle.set_auth(Some(new_token)).await;
                        info!("JWT refreshed");
                    }
                    Err(e) => warn!(error = %e, "JWT refresh failed"),
                }
            }

            // ── Pending tasks → dispatch to Restate ─────────────────────
            Some(Ok(pending)) = tasks.next() => {
                let pending: Vec<WorkerTasksTable> = pending;
                for row in &pending {
                    // Mark dispatched first (idempotent — Restate handles dedup)
                    if let Err(e) = convex
                        .worker_tasks_mark_dispatched(WorkerTasksMarkDispatchedArgs {
                            taskId: row.id.clone(),
                        })
                        .await
                    {
                        warn!(error = %e, "Failed to mark task dispatched");
                    }

                    let (service, key, handler, payload) = dispatch_info(&row.task);

                    if let Some(json) = payload {
                        restate_send_raw(&http, ingress_url, service, &key, handler, &json).await;
                    } else {
                        restate_send_empty(&http, ingress_url, service, &key, handler).await;
                    }

                    info!(service, handler, key, "Task dispatched");
                }
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Typed task → Restate dispatch routing
// ────────────────────────────────────────────────────────────────────────────

/// Derive `(service, key, handler, payload)` from a typed task variant.
///
/// Returns: `(service_name, restate_key, handler_name, optional_json_payload)`.
/// Payload is `None` for handlers that take no arguments (stop, cancel-without-doc, etc.).
///
/// For tasks with payloads, the typed `Task` variant is serialized directly.
/// Since `Task` uses `#[serde(tag = "type")]`, the JSON includes a `"type"` key
/// alongside the variant's data fields — Restate handlers simply ignore the extra key.
fn dispatch_info(task: &Task) -> (&'static str, String, &'static str, Option<String>) {
    match task {
        // ── Auth flows ───────────────────────────────────────────────
        Task::PhoneAuthRun { authId, doc } => {
            ("PhoneAuthWorkflow", authId.clone(), "run", Some(doc.clone()))
        }
        Task::PhoneAuthSubmitCode { authId } => {
            ("PhoneAuthWorkflow", authId.clone(), "submitCode", None)
        }
        Task::PhoneAuthSubmitPassword { authId } => {
            ("PhoneAuthWorkflow", authId.clone(), "submitPassword", None)
        }
        Task::PhoneAuthCancel { authId } => {
            ("PhoneAuthWorkflow", authId.clone(), "cancel", None)
        }
        Task::QrAuthRun { authId, doc } => {
            ("QrAuthWorkflow", authId.clone(), "run", Some(doc.clone()))
        }
        Task::QrAuthCancel { authId } => {
            ("QrAuthWorkflow", authId.clone(), "cancel", None)
        }

        // ── Client lifecycle ─────────────────────────────────────────
        // Serialize the full Task variant — handlers pick their fields,
        // ignoring the extra "type" key that serde adds.
        task @ Task::DialogSyncSync { clientId, .. } => (
            "DialogSync",
            clientId.clone(),
            "sync",
            Some(serde_json::to_string(task).unwrap()),
        ),
        task @ Task::UpdateListenerListen { clientId, .. } => (
            "UpdateListener",
            clientId.clone(),
            "listen",
            Some(serde_json::to_string(task).unwrap()),
        ),
        Task::UpdateListenerStop { clientId } => {
            ("UpdateListener", clientId.clone(), "stop", None)
        }
        task @ Task::ProfilePhotoSyncSync { clientId, .. } => (
            "ProfilePhotoSync",
            clientId.clone(),
            "sync",
            Some(serde_json::to_string(task).unwrap()),
        ),
        Task::ProfilePhotoSyncStop { clientId } => {
            ("ProfilePhotoSync", clientId.clone(), "stop", None)
        }

        // ── Chat scanning ────────────────────────────────────────────
        task @ Task::ChatScannerScan { chatId, .. } => (
            "ChatScanner",
            chatId.clone(),
            "scan",
            Some(serde_json::to_string(task).unwrap()),
        ),

        // ── Per-file media download ──────────────────────────────────
        task @ Task::MediaDownloaderDownload {
            telegramFileId, ..
        } => (
            "MediaDownloader",
            telegramFileId.clone(),
            "download",
            Some(serde_json::to_string(task).unwrap()),
        ),
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Session discovery (runs once at startup)
// ────────────────────────────────────────────────────────────────────────────

async fn discover_and_register_sessions(client: &ConvexApiClient, config: &WorkerConfig) {
    let sessions = discover_session_files();
    if sessions.is_empty() {
        info!("No existing session files found");
        return;
    }

    info!(count = sessions.len(), "Found session files, checking authorization");

    let mut registered = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;

    for (owner_id, session_path) in &sessions {
        let path_str = session_path.to_string_lossy().to_string();

        let tg_client =
            match TelegramClient::new(config.api_id, config.api_hash.clone(), path_str).await {
                Ok(c) => c,
                Err(e) => {
                    warn!(path = ?session_path, error = %e, "Failed to load session file");
                    failed += 1;
                    continue;
                }
            };

        match tg_client.is_authorized().await {
            Ok(true) => {}
            Ok(false) => {
                debug!(path = ?session_path, "Session not authorized, skipping");
                skipped += 1;
                continue;
            }
            Err(e) => {
                warn!(path = ?session_path, error = %e, "Failed to check authorization");
                failed += 1;
                continue;
            }
        }

        let external_id = match tg_client.get_client_external_id().await {
            Ok(id) => id,
            Err(e) => {
                warn!(path = ?session_path, error = %e, "Failed to get client external ID");
                failed += 1;
                continue;
            }
        };

        match client
            .clients_worker_register_connected(ClientsWorkerRegisterConnectedArgs {
                userId: owner_id.clone(),
                telegramId: external_id.clone(),
                kind: "Telegram".to_string(),
            })
            .await
            .check()
        {
            Ok(client_id) => {
                registered += 1;
                info!(
                    client_id,
                    external_id = %external_id,
                    owner = %owner_id,
                    "Registered session from disk"
                );
            }
            Err(e) => {
                warn!(
                    external_id = %external_id,
                    owner = %owner_id,
                    error = %e,
                    "Failed to register session in Convex"
                );
                failed += 1;
            }
        }
    }

    info!(registered, skipped, failed, "Session discovery complete");
}
