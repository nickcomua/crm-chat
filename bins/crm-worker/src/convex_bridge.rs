//! Convex subscription bridge → Restate workflow triggers.
//!
//! Subscribes to Convex queries for pending/assigned auth sessions and connected
//! clients. When subscription snapshots change, dispatches to the corresponding
//! Restate services via HTTP ingress calls.
//!
//! This replaces the old `tokio::select!` event loop in telegram-subscriber's
//! `main.rs`, but is much simpler: it only *listens* and *dispatches*. All
//! actual work happens in Restate handlers.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use convex_backend::{
    ClientsWorkerRegisterConnectedArgs, ConvexApi, ConvexApiClient, PhoneAuthsStep, QrAuthsStep,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use tracing::{debug, info, warn};

use crate::auth::mint_worker_jwt;
use crate::config::{WorkerConfig, discover_session_files};
use crate::services::client_scanner::StartScanRequest;
use crate::services::phone_auth::{PhoneAuthRequest, SubmitCodeRequest, SubmitPasswordRequest};
use crate::services::qr_auth::QrAuthRequest;

// Re-export generated table types with shorter aliases
use convex_backend::ClientsTable as Client;
use convex_backend::PhoneAuthsTable as PhoneAuth;
use convex_backend::QrAuthsTable as QrAuth;

/// Run the Convex subscription bridge.
///
/// This function runs forever, subscribing to Convex queries and dispatching
/// to Restate workflows/virtual objects when subscription snapshots change.
pub async fn run(config: &WorkerConfig) -> anyhow::Result<()> {
    let restate_url = config.restate_ingress_url.clone();

    // Mint JWT and connect to Convex
    let token = mint_worker_jwt(&config.private_key, &config.robot_id, &config.robot_kid)?;
    let mut raw_client = ::convex::ConvexClient::new(&config.convex_url).await?;
    raw_client.set_auth(Some(token)).await;
    let client = ConvexApiClient::new(raw_client);

    info!(robot_id = %config.robot_id, "Convex bridge connected");

    // Discover existing session files and register them
    discover_and_register_sessions(&client, config).await;

    // Subscribe to auth queries
    let mut phone_pending = client.subscribe_phone_auth_pending_for_worker().await?;
    let mut phone_assigned = client.subscribe_phone_auth_assigned_to_worker().await?;
    let mut qr_pending = client.subscribe_qr_auth_pending_for_worker().await?;
    let mut qr_assigned = client.subscribe_qr_auth_assigned_to_worker().await?;
    let mut connected_clients = client.subscribe_clients_connected_for_worker().await?;

    // State tracking for diffing subscription snapshots
    let mut phone_assigned_steps: HashMap<String, PhoneAuthsStep> = HashMap::new();
    let mut qr_assigned_steps: HashMap<String, QrAuthsStep> = HashMap::new();
    let mut active_scans: HashSet<String> = HashSet::new();

    // JWT refresh timer (every 50 minutes)
    let mut jwt_refresh = tokio::time::interval(Duration::from_secs(50 * 60));
    jwt_refresh.tick().await;

    let http = reqwest::Client::new();

    info!("Convex bridge started, entering subscription loop");

    loop {
        tokio::select! {
            biased;

            _ = tokio::signal::ctrl_c() => {
                info!("Shutting down Convex bridge...");
                break;
            }

            // JWT refresh — clone the inner ConvexClient (clones share the
            // underlying connection) so we can call `set_auth(&mut self)`.
            _ = jwt_refresh.tick() => {
                match mint_worker_jwt(&config.private_key, &config.robot_id, &config.robot_kid) {
                    Ok(new_token) => {
                        let mut auth_handle = client.inner().clone();
                        auth_handle.set_auth(Some(new_token)).await;
                        info!("JWT refreshed");
                    }
                    Err(e) => warn!(error = %e, "JWT refresh failed"),
                }
            }

            // ── Phone auth: pending → claim ──────────────────────────────
            Some(Ok(auths)) = phone_pending.next() => {
                let auths: Vec<PhoneAuth> = auths;
                for auth in &auths {
                    debug!(auth_id = %auth.id, "Claiming pending phone auth");
                    // Claim by starting the Restate workflow
                    let req = PhoneAuthRequest {
                        auth_id: auth.id.clone(),
                        user_id: auth.user_id.clone(),
                        phone: auth.phone.clone(),
                    };
                    if let Err(e) = send_restate(
                        &http,
                        &restate_url,
                        "PhoneAuthWorkflow",
                        &auth.id,
                        "run",
                        &req,
                    )
                    .await
                    {
                        warn!(auth_id = %auth.id, error = %e, "Failed to start phone auth workflow");
                    }
                }
            }

            // ── Phone auth: assigned → resolve promises on step change ───
            Some(Ok(auths)) = phone_assigned.next() => {
                let auths: Vec<PhoneAuth> = auths;
                let new_steps: HashMap<String, PhoneAuthsStep> = auths.iter()
                    .map(|a| (a.id.clone(), a.step))
                    .collect();

                for auth in &auths {
                    let should_dispatch = phone_assigned_steps.get(&auth.id)
                        .map(|old| *old != auth.step)
                        .unwrap_or(true);

                    if !should_dispatch {
                        continue;
                    }

                    match auth.step {
                        PhoneAuthsStep::VerifyingCode => {
                            // User submitted the code — resolve the "code" promise
                            if let (Some(code), Some(hash)) =
                                (&auth.login_code, &auth.phone_code_hash)
                            {
                                let req = SubmitCodeRequest {
                                    login_code: code.clone(),
                                    phone_code_hash: hash.clone(),
                                };
                                if let Err(e) = send_restate(
                                    &http,
                                    &restate_url,
                                    "PhoneAuthWorkflow",
                                    &auth.id,
                                    "submit_code",
                                    &req,
                                )
                                .await
                                {
                                    warn!(auth_id = %auth.id, error = %e, "Failed to submit code");
                                }
                            }
                        }
                        PhoneAuthsStep::VerifyingPassword => {
                            // User submitted the password — resolve the "password" promise
                            if let (Some(pw), Some(token)) =
                                (&auth.password, &auth.password_token)
                            {
                                let req = SubmitPasswordRequest {
                                    password: pw.clone(),
                                    password_token: token.clone(),
                                };
                                if let Err(e) = send_restate(
                                    &http,
                                    &restate_url,
                                    "PhoneAuthWorkflow",
                                    &auth.id,
                                    "submit_password",
                                    &req,
                                )
                                .await
                                {
                                    warn!(auth_id = %auth.id, error = %e, "Failed to submit password");
                                }
                            }
                        }
                        PhoneAuthsStep::Cancelled => {
                            if let Err(e) = send_restate::<()>(
                                &http,
                                &restate_url,
                                "PhoneAuthWorkflow",
                                &auth.id,
                                "cancel",
                                &(),
                            )
                            .await
                            {
                                warn!(auth_id = %auth.id, error = %e, "Failed to cancel phone auth");
                            }
                        }
                        _ => {
                            debug!(auth_id = %auth.id, step = ?auth.step, "No bridge action needed");
                        }
                    }
                }

                phone_assigned_steps = new_steps;
            }

            // ── QR auth: pending → start workflow ────────────────────────
            Some(Ok(auths)) = qr_pending.next() => {
                let auths: Vec<QrAuth> = auths;
                for auth in &auths {
                    debug!(auth_id = %auth.id, "Starting QR auth workflow");
                    let req = QrAuthRequest {
                        auth_id: auth.id.clone(),
                        user_id: auth.user_id.clone(),
                    };
                    if let Err(e) = send_restate(
                        &http,
                        &restate_url,
                        "QrAuthWorkflow",
                        &auth.id,
                        "run",
                        &req,
                    )
                    .await
                    {
                        warn!(auth_id = %auth.id, error = %e, "Failed to start QR auth workflow");
                    }
                }
            }

            // ── QR auth: assigned → cancel on disappearance ──────────────
            Some(Ok(auths)) = qr_assigned.next() => {
                let auths: Vec<QrAuth> = auths;
                let new_ids: HashSet<String> = auths.iter()
                    .map(|a| a.id.clone())
                    .collect();

                // Cancel workflows for auths that disappeared
                let removed: Vec<String> = qr_assigned_steps.keys()
                    .filter(|id| !new_ids.contains(*id))
                    .cloned()
                    .collect();
                for id in &removed {
                    info!(auth_id = %id, "QR auth disappeared, cancelling workflow");
                    let _ = send_restate::<()>(
                        &http,
                        &restate_url,
                        "QrAuthWorkflow",
                        id,
                        "cancel",
                        &(),
                    )
                    .await;
                }

                // Process step changes
                for auth in &auths {
                    let should_dispatch = qr_assigned_steps.get(&auth.id)
                        .map(|old| *old != auth.step)
                        .unwrap_or(true);

                    if should_dispatch && auth.step == QrAuthsStep::Generating {
                        // The run handler handles the full QR loop — nothing extra to dispatch
                        debug!(auth_id = %auth.id, "QR auth in Generating step (handled by workflow)");
                    }
                }

                qr_assigned_steps = auths.iter()
                    .map(|a| (a.id.clone(), a.step))
                    .collect();
            }

            // ── Connected clients: start/stop scans ──────────────────────
            Some(Ok(clients)) = connected_clients.next() => {
                let clients: Vec<Client> = clients;
                let new_ids: HashSet<String> = clients.iter()
                    .map(|c| c.id.clone())
                    .collect();

                // Stop scans for disconnected clients
                let removed: Vec<String> = active_scans.iter()
                    .filter(|id| !new_ids.contains(*id))
                    .cloned()
                    .collect();
                for id in &removed {
                    info!(client_id = %id, "Client disconnected, stopping scan");
                    let _ = send_restate::<()>(
                        &http,
                        &restate_url,
                        "ClientScanner",
                        id,
                        "stop_scan",
                        &(),
                    )
                    .await;
                    active_scans.remove(id);
                }

                // Start scans for newly connected clients
                for client in &clients {
                    if active_scans.contains(&client.id) {
                        continue;
                    }

                    info!(
                        client_id = %client.id,
                        external_id = %client.telegram_id,
                        "Starting scan for connected client"
                    );

                    let req = StartScanRequest {
                        client_id: client.id.clone(),
                        user_id: client.user_id.clone(),
                        external_id: client.telegram_id.clone(),
                    };
                    if let Err(e) = send_restate(
                        &http,
                        &restate_url,
                        "ClientScanner",
                        &client.id,
                        "start_scan",
                        &req,
                    )
                    .await
                    {
                        warn!(client_id = %client.id, error = %e, "Failed to start scan");
                    } else {
                        active_scans.insert(client.id.clone());
                    }
                }
            }
        }
    }

    Ok(())
}

/// Send a request to a Restate service handler via HTTP ingress.
///
/// Uses Restate's `Send` semantics (fire-and-forget) to avoid blocking the
/// bridge loop on workflow execution.
async fn send_restate<T: serde::Serialize>(
    http: &reqwest::Client,
    ingress_url: &str,
    service: &str,
    key: &str,
    handler: &str,
    body: &T,
) -> Result<(), anyhow::Error> {
    let url = format!("{ingress_url}/{service}/{key}/{handler}/send");
    let response = http
        .post(&url)
        .json(body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Restate ingress error (HTTP {status}): {body}");
    }

    Ok(())
}

/// Discover existing session files on disk and register them as Connected.
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
        {
            Ok(result) => {
                registered += 1;
                info!(
                    result = ?result,
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
