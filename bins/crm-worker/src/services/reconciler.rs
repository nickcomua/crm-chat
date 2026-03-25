//! Reconciler — Kubernetes-style reconciliation loop that subscribes to
//! `orchestrator.pendingWork` and dispatches new work items to Restate.
//!
//! No task table, no `markDispatched`, no `resetStale`.
//! Domain entity state IS the queue. The reconciler maintains an in-memory
//! `in_flight` set to avoid redundant Restate sends; Restate's virtual-object
//! keying is the ultimate dedup guarantee.
//!
//! On restart, `in_flight` is empty → everything re-dispatched → Restate deduplicates.

use std::collections::HashSet;
use std::time::Duration;

use convex_backend::{
    ClientsWorkerRegisterConnectedArgs, ConvexApi, ConvexApiClient, OrchestratorPendingWorkArgs,
    OrchestratorPendingWorkReturn,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::auth::fetch_m2m_jwt;
use crate::config::WorkerConfig;
use crate::error::WorkerError;
use crate::session_manager::{SessionManager, TelegramSessionManager};

/// Extract (service, key, handler) from any `OrchestratorPendingWorkReturn` variant.
///
/// The generated enum has 7 untagged variants (one per work item type in the union),
/// but they all share the same shape: `{ service, key, handler }`.
fn work_item_fields(item: &OrchestratorPendingWorkReturn) -> (&str, &str, &str) {
    match item {
        OrchestratorPendingWorkReturn::Object(o) => (&o.service, &o.key, &o.handler),
        OrchestratorPendingWorkReturn::Object2(o) => (&o.service, &o.key, &o.handler),
        OrchestratorPendingWorkReturn::Object3(o) => (&o.service, &o.key, &o.handler),
        OrchestratorPendingWorkReturn::Object4(o) => (&o.service, &o.key, &o.handler),
        OrchestratorPendingWorkReturn::Object5(o) => (&o.service, &o.key, &o.handler),
        OrchestratorPendingWorkReturn::Object6(o) => (&o.service, &o.key, &o.handler),
        OrchestratorPendingWorkReturn::Object7(o) => (&o.service, &o.key, &o.handler),
    }
}

/// Fire-and-forget dispatch to a Restate service handler via HTTP ingress.
async fn restate_send(
    http: &reqwest::Client,
    ingress_url: &str,
    service: &str,
    key: &str,
    handler: &str,
) {
    let payload = serde_json::json!({ "entity_id": key });
    let url = format!("{ingress_url}/{service}/{key}/{handler}/send");
    match http
        .post(&url)
        .header("Content-Type", "application/json")
        .body(payload.to_string())
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
// Main reconciliation loop
// ────────────────────────────────────────────────────────────────────────────

/// Run the reconciler loop. Call from a tokio task in main.rs.
pub async fn run_reconciler(
    convex: &ConvexApiClient,
    config: &WorkerConfig,
    sessions: &TelegramSessionManager,
    ingress_url: &str,
    token: &CancellationToken,
) -> Result<(), anyhow::Error> {
    info!("Reconciler: cleaning up orphaned temp sessions");
    sessions.cleanup_temp_sessions();

    info!("Reconciler: discovering sessions");
    discover_and_register_sessions(convex, config, sessions).await;

    // No resetStale needed — on restart, in_flight is empty, everything
    // re-dispatches, Restate deduplicates by virtual-object key.

    let http = reqwest::Client::new();
    let mut in_flight: HashSet<(String, String)> = HashSet::new();

    let max_media = if config.max_media_workflows > 0 {
        Some(config.max_media_workflows as f64)
    } else {
        None
    };
    info!(
        max_media_workflows = config.max_media_workflows,
        "Media workflow concurrency limit"
    );

    let mut work_sub = convex
        .subscribe_orchestrator_pending_work(OrchestratorPendingWorkArgs {
            maxMediaDownloads: max_media,
        })
        .await?;

    // JWT refresh timer (every 50 minutes)
    let mut jwt_refresh = tokio::time::interval(Duration::from_secs(50 * 60));
    jwt_refresh.tick().await;

    info!("Reconciler: entering subscription loop");

    loop {
        tokio::select! {
            biased;

            // ── Cancellation ────────────────────────────────────────────
            _ = token.cancelled() => {
                info!("Reconciler: cancelled");
                return Ok(());
            }

            // ── JWT refresh ─────────────────────────────────────────────
            _ = jwt_refresh.tick() => {
                match fetch_m2m_jwt(&http, &config.m2m_secret_key).await {
                    Ok(new_token) => {
                        let mut auth_handle = convex.inner().clone();
                        auth_handle.set_auth(Some(new_token)).await;
                        info!("JWT refreshed");
                    }
                    Err(e) => warn!(error = %e, "JWT refresh failed"),
                }
            }

            // ── Pending work → reconcile ─────────────────────────────
            Some(Ok(work_items)) = work_sub.next() => {
                let work_items: Vec<OrchestratorPendingWorkReturn> = work_items;

                // Build current key set from the query result
                let current_keys: HashSet<(String, String)> = work_items
                    .iter()
                    .map(|item| {
                        let (service, key, _) = work_item_fields(item);
                        (service.to_string(), key.to_string())
                    })
                    .collect();

                // Dispatch new items (not yet in flight)
                for item in &work_items {
                    let (service, key, handler) = work_item_fields(item);
                    let flight_key = (service.to_string(), key.to_string());

                    if !in_flight.contains(&flight_key) {
                        restate_send(&http, ingress_url, service, key, handler).await;
                        in_flight.insert(flight_key);
                        info!(service, key, handler, "Work dispatched");
                    }
                }

                // Prune completed (disappeared from query)
                let before = in_flight.len();
                in_flight.retain(|k| current_keys.contains(k));
                let pruned = before - in_flight.len();
                if pruned > 0 {
                    debug!(pruned, "Pruned completed items from in_flight set");
                }
            }
        }
    }
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
