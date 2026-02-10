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

use config::{get_session_dir, TelegramConfig};
use convex::ConvexClient;
use futures::StreamExt;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::task::{claim_phone_auth, claim_qr_auth, execute_phone_auth, execute_qr_auth, TaskExecutionContext};
use crate::types::{check_result, parse_phone_auths, parse_qr_auths, ConvexApi, PhoneAuthStep, QrAuthStep};

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
    let private_key = env::var("ROBOT_JWT_PRIVATE_KEY").expect("ROBOT_JWT_PRIVATE_KEY must be set");

    // Mint JWT and connect to Convex
    let token = jwt::mint_robot_jwt(&private_key, &robot_id)?;
    let mut client = ConvexClient::new(&convex_url).await?;
    client.set_auth(Some(token)).await;

    info!(robot_id = %robot_id, "Connected to Convex");

    // Register as robot
    check_result(client.robots_register().await)
        .map_err(|e| anyhow::anyhow!("Failed to register robot: {}", e))?;

    info!("Robot registered");

    // Clone for TaskExecutionContext (mutations use their own clones internally)
    let ctx = TaskExecutionContext {
        client: client.clone(),
        robot_id: robot_id.clone(),
        config: config.clone(),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        qr_polling_tasks: Arc::new(Mutex::new(HashMap::new())),
    };

    // Subscribe to auth queries
    let mut phone_pending = client.subscribe_phone_auth_pending_for_robot().await?;
    let mut phone_assigned = client.subscribe_phone_auth_assigned_to_robot().await?;
    let mut qr_pending = client.subscribe_qr_auth_pending_for_robot().await?;
    let mut qr_assigned = client.subscribe_qr_auth_assigned_to_robot().await?;

    info!(session_dir = ?get_session_dir(), "Session files stored in");

    // State tracking for diffing subscription snapshots
    let mut phone_assigned_steps: HashMap<String, PhoneAuthStep> = HashMap::new();
    let mut qr_assigned_steps: HashMap<String, QrAuthStep> = HashMap::new();

    // Timers for heartbeat and JWT refresh
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
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

            // Heartbeat: keep robot marked as online
            _ = heartbeat.tick() => {
                if let Err(e) = check_result(ctx.client.clone().robots_heartbeat().await) {
                    warn!(error = %e, "Heartbeat failed");
                }
            }

            // JWT refresh: mint a new token before the old one expires
            _ = jwt_refresh.tick() => {
                match jwt::mint_robot_jwt(&private_key, &robot_id) {
                    Ok(new_token) => {
                        let mut auth_client = client.clone();
                        auth_client.set_auth(Some(new_token)).await;
                        info!("JWT refreshed");
                    }
                    Err(e) => warn!(error = %e, "JWT refresh failed"),
                }
            }

            // Pending phone auths: try to claim each one
            Some(result) = phone_pending.next() => {
                for auth in parse_phone_auths(&result) {
                    debug!(auth_id = %auth.id, "Found pending phone auth, attempting claim");
                    if let Err(e) = claim_phone_auth(&ctx.client, &auth.id).await {
                        warn!(auth_id = %auth.id, error = %e, "Failed to claim phone auth");
                    }
                }
            }

            // Assigned phone auths: execute step transitions
            Some(result) = phone_assigned.next() => {
                let auths = parse_phone_auths(&result);
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
            Some(result) = qr_pending.next() => {
                for auth in parse_qr_auths(&result) {
                    debug!(auth_id = %auth.id, "Found pending QR auth, attempting claim");
                    if let Err(e) = claim_qr_auth(&ctx.client, &auth.id).await {
                        warn!(auth_id = %auth.id, error = %e, "Failed to claim QR auth");
                    }
                }
            }

            // Assigned QR auths: execute step transitions, cancel polling on disappearance
            Some(result) = qr_assigned.next() => {
                let auths = parse_qr_auths(&result);
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
        }
    }

    Ok(())
}
