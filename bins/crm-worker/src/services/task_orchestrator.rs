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
    ClientsWorkerRegisterConnectedArgs, ConvexApi, ConvexApiClient, WorkerTasksMarkDispatchedArgs,
    WorkerTasksPendingForWorkerArgs, WorkerTasksTable, WorkerTasksTask as Task,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::auth::mint_worker_jwt;
use crate::config::WorkerConfig;
use crate::error::WorkerError;
use crate::session_manager::{SessionManager, TelegramSessionManager};

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

// ────────────────────────────────────────────────────────────────────────────
// Main orchestration loop (plain async — NOT a Restate handler)
// ────────────────────────────────────────────────────────────────────────────

/// Run the orchestrator loop. Call from a tokio task in main.rs.
pub async fn run_orchestrator(
    convex: &ConvexApiClient,
    config: &WorkerConfig,
    sessions: &TelegramSessionManager,
    ingress_url: &str,
    token: &CancellationToken,
) -> Result<(), anyhow::Error> {
    info!("TaskOrchestrator: cleaning up orphaned temp sessions");
    sessions.cleanup_temp_sessions();

    info!("TaskOrchestrator: discovering sessions");
    discover_and_register_sessions(convex, config, sessions).await;

    // Reset stale Dispatched/Running tasks from a previous run so they get re-dispatched.
    // Restate deduplicates by virtual-object key, so double-dispatch is harmless.
    match convex.worker_tasks_reset_stale().await {
        Ok(n) => {
            if n > 0.0 {
                info!(count = n, "Reset stale tasks to Pending");
            }
        }
        Err(e) => warn!(error = %e, "Failed to reset stale tasks"),
    }

    let http = reqwest::Client::new();

    // Single subscription: all pending worker tasks (with media workflow limit)
    let max_media = if config.max_media_workflows > 0 {
        Some(config.max_media_workflows as f64)
    } else {
        None
    };
    info!(
        max_media_workflows = config.max_media_workflows,
        "Media workflow concurrency limit"
    );
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

                    let (service, key, handler, payload) = dispatch_info(row);

                    restate_send_raw(&http, ingress_url, service, &key, handler, &payload).await;

                    info!(service, handler, key, "Task dispatched");
                }
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Typed task → Restate dispatch routing
// ────────────────────────────────────────────────────────────────────────────

/// Derive `(service, key, handler, payload)` from a worker task row.
///
/// Returns: `(service_name, restate_key, handler_name, json_payload)`.
///
/// Every payload includes `task_id` so handlers can call `runTask` and
/// `workerComplete`. For most tasks, the Task variant is serialized and
/// `task_id` is injected alongside. Auth flows build custom payloads.
fn dispatch_info(row: &WorkerTasksTable) -> (&'static str, String, &'static str, String) {
    match &row.task {
        // ── Auth flows ───────────────────────────────────────────────
        Task::PhoneAuth { authId } => {
            let payload = serde_json::json!({
                "task_id": row.id,
                "auth_id": authId,
            });
            (
                "PhoneAuthWorkflow",
                authId.clone(),
                "run",
                payload.to_string(),
            )
        }
        Task::QrAuth { .. } => {
            let payload = serde_json::json!({
                "task_id": row.id,
                "user_id": row.user_id.as_deref().unwrap_or(""),
            });
            ("QrAuthWorkflow", row.id.clone(), "run", payload.to_string())
        }

        // ── Client lifecycle ─────────────────────────────────────────
        Task::DialogSync { clientId, .. } => {
            ("DialogSync", clientId.clone(), "sync", task_payload(row))
        }
        Task::UpdateListener { clientId, .. } => (
            "UpdateListener",
            clientId.clone(),
            "listen",
            task_payload(row),
        ),
        Task::ProfilePhotoSync { clientId, .. } => (
            "ProfilePhotoSync",
            clientId.clone(),
            "sync",
            task_payload(row),
        ),

        // ── Chat scanning ────────────────────────────────────────────
        Task::ChatScanner { chatId, .. } => {
            ("ChatScanner", chatId.clone(), "scan", task_payload(row))
        }

        // ── Per-file media download ──────────────────────────────────
        Task::MediaDownloader { telegramFileId, .. } => (
            "MediaDownloader",
            telegramFileId.clone(),
            "download",
            task_payload(row),
        ),
    }
}

/// Serialize a task variant with `task_id` injected alongside the variant fields.
fn task_payload(row: &WorkerTasksTable) -> String {
    let mut obj = serde_json::to_value(&row.task).unwrap();
    obj.as_object_mut()
        .unwrap()
        .insert("task_id".to_string(), serde_json::json!(row.id));
    obj.to_string()
}

// ────────────────────────────────────────────────────────────────────────────
// Session discovery (runs once at startup)
// ────────────────────────────────────────────────────────────────────────────

async fn discover_and_register_sessions(
    client: &ConvexApiClient,
    config: &WorkerConfig,
    sessions: &TelegramSessionManager,
) {
    let discovered = sessions.discover_sessions();
    if discovered.is_empty() {
        info!("No existing session files found");
        return;
    }

    info!(
        count = discovered.len(),
        "Found session files, checking authorization"
    );

    let mut registered = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;

    for (owner_id, session_path) in &discovered {
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

        let numeric_id = tg_client.get_numeric_external_id().await.ok();
        let phone_number = tg_client.get_phone_number().await;

        match client
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
