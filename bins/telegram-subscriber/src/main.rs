//! Telegram subscriber service for CRM Chat.
//!
//! This service connects to a Convex backend, subscribes to phone_auth and qr_auth
//! queries, and processes robot tasks for Telegram client authentication.

mod config;
mod error;
mod jwt;
mod task;
mod types;

use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::Duration;

use config::{TelegramConfig, get_session_dir};
use convex::ConvexClient;
use futures::StreamExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

use crate::task::{
    TaskExecutionContext, claim_phone_auth, claim_qr_auth, execute_phone_auth, execute_qr_auth,
};
use crate::types::{Client, ConvexApi, PhoneAuth, PhoneAuthStep, QrAuth, QrAuthStep};

/// Handle for a running scan task (one per connected client).
struct ScanTaskHandle {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

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

    // Initialize tracing with Sentry layer
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,telegram_subscriber=debug"));

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_tracing::layer());

    tracing::subscriber::set_global_default(subscriber)?;

    info!("Starting telegram-subscriber");

    if _guard.is_some() {
        info!("Sentry error tracking enabled");
    }

    let config = TelegramConfig::from_env()?;

    // Load Convex connection settings
    let convex_url = env::var("CONVEX_URL").expect("CONVEX_URL must be set");
    let robot_id = env::var("ROBOT_ID").expect("ROBOT_ID must be set");
    let robot_kid = env::var("ROBOT_KID").expect("ROBOT_KID must be set");
    let private_key = env::var("ROBOT_JWT_PRIVATE_KEY")
        .expect("ROBOT_JWT_PRIVATE_KEY must be set")
        .replace("\\n", "\n");

    // Mint JWT and connect to Convex
    let token = jwt::mint_robot_jwt(&private_key, &robot_id, &robot_kid)?;
    let mut client = ConvexClient::new(&convex_url).await?;
    client.set_auth(Some(token)).await;

    info!(robot_id = %robot_id, "Connected to Convex");

    // Clone for TaskExecutionContext (mutations use their own clones internally)
    let ctx = Arc::new(TaskExecutionContext {
        client: client.clone(),
        robot_id: robot_id.clone(),
        config: config.clone(),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        qr_polling_tasks: Arc::new(Mutex::new(HashMap::new())),
    });

    // Subscribe to auth queries
    let mut phone_pending = client.subscribe_phone_auth_pending_for_robot().await?;
    let mut phone_assigned = client.subscribe_phone_auth_assigned_to_robot().await?;
    let mut qr_pending = client.subscribe_qr_auth_pending_for_robot().await?;
    let mut qr_assigned = client.subscribe_qr_auth_assigned_to_robot().await?;

    // Subscribe to connected clients (for scanning)
    let mut connected_clients = client.subscribe_clients_connected_for_robot().await?;

    info!(session_dir = ?get_session_dir(), "Session files stored in");

    // State tracking for diffing subscription snapshots
    let mut phone_assigned_steps: HashMap<String, PhoneAuthStep> = HashMap::new();
    let mut qr_assigned_steps: HashMap<String, QrAuthStep> = HashMap::new();

    // Active scan tasks keyed by client._id
    let mut scan_tasks: HashMap<String, ScanTaskHandle> = HashMap::new();

    // Timer for JWT refresh
    let mut jwt_refresh = tokio::time::interval(Duration::from_secs(50 * 60));
    jwt_refresh.tick().await; // consume first immediate tick

    info!("Telegram subscriber started. Press Ctrl+C to exit.");

    loop {
        tokio::select! {
            biased;

            _ = tokio::signal::ctrl_c() => {
                info!("Shutting down...");
                break;
            }

            // JWT refresh: mint a new token before the old one expires
            _ = jwt_refresh.tick() => {
                match jwt::mint_robot_jwt(&private_key, &robot_id, &robot_kid) {
                    Ok(new_token) => {
                        let mut auth_client = client.clone();
                        auth_client.set_auth(Some(new_token)).await;
                        info!("JWT refreshed");
                    }
                    Err(e) => warn!(error = %e, "JWT refresh failed"),
                }
            }

            // Pending phone auths: try to claim each one
            Some(Ok(auths)) = phone_pending.next() => {
                for auth in auths {
                    debug!(auth_id = %auth.id, "Found pending phone auth, attempting claim");
                    if let Err(e) = claim_phone_auth(&ctx.client, &auth.id).await {
                        warn!(auth_id = %auth.id, error = %e, "Failed to claim phone auth");
                    }
                }
            }

            // Assigned phone auths: execute step transitions
            Some(Ok(auths)) = phone_assigned.next() => {
                let auths: Vec<PhoneAuth> = auths;
                let new_steps: HashMap<String, PhoneAuthStep> = auths.iter()
                    .map(|a| (a.id.clone(), a.step))
                    .collect();

                for auth in &auths {
                    let should_execute = phone_assigned_steps.get(&auth.id)
                        .map(|old_step| *old_step != auth.step)
                        .unwrap_or(true); // new doc = always process

                    if should_execute {
                        match auth.step {
                            PhoneAuthStep::SendingCode
                            | PhoneAuthStep::VerifyingCode
                            | PhoneAuthStep::VerifyingPassword => {
                                info!(auth_id = %auth.id, step = ?auth.step, "Executing phone auth step");
                                if let Err(e) = execute_phone_auth(&ctx, auth).await {
                                    error!(auth_id = %auth.id, error = %e, "Failed to execute phone auth");
                                }
                            }
                            _ => {
                                debug!(auth_id = %auth.id, step = ?auth.step, "No robot action for phone auth step");
                            }
                        }
                    }
                }

                phone_assigned_steps = new_steps;
            }

            // Pending QR auths: try to claim each one
            Some(Ok(auths)) = qr_pending.next() => {
                for auth in auths {
                    debug!(auth_id = %auth.id, "Found pending QR auth, attempting claim");
                    if let Err(e) = claim_qr_auth(&ctx.client, &auth.id).await {
                        warn!(auth_id = %auth.id, error = %e, "Failed to claim QR auth");
                    }
                }
            }

            // Assigned QR auths: execute step transitions, cancel polling on disappearance
            Some(Ok(auths)) = qr_assigned.next() => {
                let auths: Vec<QrAuth> = auths;
                let new_ids: std::collections::HashSet<String> = auths.iter()
                    .map(|a| a.id.clone())
                    .collect();

                // Cancel polling for auths that disappeared (reached terminal state server-side)
                let removed_ids: Vec<String> = qr_assigned_steps.keys()
                    .filter(|id| !new_ids.contains(*id))
                    .cloned()
                    .collect();
                for id in &removed_ids {
                    ctx.cancel_qr_polling(id).await;
                }

                // Process auths with step changes
                for auth in &auths {
                    let should_execute = qr_assigned_steps.get(&auth.id)
                        .map(|old_step| *old_step != auth.step)
                        .unwrap_or(true);

                    if should_execute && auth.step == QrAuthStep::Generating {
                        info!(auth_id = %auth.id, "Executing QR auth");
                        if let Err(e) = execute_qr_auth(&ctx, auth).await {
                            error!(auth_id = %auth.id, error = %e, "Failed to execute QR auth");
                        }
                    }
                }

                qr_assigned_steps = auths.iter()
                    .map(|a| (a.id.clone(), a.step))
                    .collect();
            }

            // Connected clients: start/stop scan tasks
            Some(Ok(clients)) = connected_clients.next() => {
                let clients: Vec<Client> = clients;
                let new_ids: std::collections::HashSet<String> = clients.iter()
                    .map(|c| c.id.clone())
                    .collect();

                // Cancel scan tasks for clients that are no longer connected
                let removed: Vec<String> = scan_tasks.keys()
                    .filter(|id| !new_ids.contains(*id))
                    .cloned()
                    .collect();
                for id in &removed {
                    if let Some(handle) = scan_tasks.remove(id) {
                        info!(client_id = %id, "Cancelling scan task (client disconnected)");
                        handle.cancel.cancel();
                        handle.task.abort();
                    }
                }

                // Start scan tasks for newly connected clients
                for client in &clients {
                    if scan_tasks.contains_key(&client.id) {
                        continue; // already scanning
                    }

                    let cancel = CancellationToken::new();
                    let ctx_clone = ctx.clone();
                    let client_clone = client.clone();
                    let cancel_clone = cancel.clone();

                    info!(client_id = %client.id, external_id = %client.external_id, "Starting scan task");

                    let task = tokio::spawn(async move {
                        if let Err(e) = task::scan::scan_client(&ctx_clone, &client_clone, cancel_clone).await {
                            error!(
                                client_id = %client_clone.id,
                                error = %e,
                                "Scan task failed"
                            );
                        }
                    });

                    scan_tasks.insert(client.id.clone(), ScanTaskHandle { cancel, task });
                }
            }
        }
    }

    // Clean up scan tasks on shutdown
    for (id, handle) in scan_tasks {
        info!(client_id = %id, "Cancelling scan task (shutdown)");
        handle.cancel.cancel();
        handle.task.abort();
    }

    Ok(())
}
