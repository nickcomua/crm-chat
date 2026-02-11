//! Executor for Generating QR auth step.
//!
//! This step generates QR code login tokens and polls for completion.

use std::collections::HashMap;
use std::sync::Arc;

use convex::ConvexClient;
use convex_backend::{QrAuthRobotCompleteQrAuthArgs, QrAuthRobotCompleteQrAuthResult, QrAuthRobotUpdateQrTokenArgs};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::{QrLoginToken, TelegramClient};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, instrument, warn};

use super::{QrPollingHandle, SessionKey, TaskExecutionContext};
use crate::error::TaskError;
use crate::types::{check_result, ConvexApi, QrAuth};

/// Execute the Generating step of a QR auth flow.
///
/// This will:
/// 1. Start the QR login flow
/// 2. Update the auth row with Token outputs as new QR codes are generated
/// 3. Complete the auth when login succeeds or fails
///
/// Note: This spawns a background task for polling, so it returns quickly.
#[instrument(skip(ctx), fields(auth_id = %auth.id))]
pub async fn execute(ctx: &TaskExecutionContext, auth: &QrAuth) -> Result<(), TaskError> {
    info!("Executing generate_qr_code");

    // Cancel any existing QR polling for this auth_id
    ctx.cancel_qr_polling(&auth.id).await;

    // Use auth_id as the session identifier for QR login
    let session_id = auth.id.clone();

    // Get or create Telegram client with auth_id as identifier
    let tg_client = ctx
        .get_or_create_client(&auth.user_id, &session_id)
        .await?;

    // Check if already authorized
    match tg_client.is_authorized().await {
        Ok(true) => {
            info!("Client is already authorized");
            let user_id = get_telegram_user_id(&tg_client).await;
            check_result(
                ctx.client
                    .clone()
                    .qr_auth_robot_complete_qr_auth(QrAuthRobotCompleteQrAuthArgs {
                        authId: auth.id.clone(),
                        result: QrAuthRobotCompleteQrAuthResult::AlreadyAuthorized { userId: user_id },
                    })
                    .await,
            )?;
            return Ok(());
        }
        Ok(false) => {
            info!("Client is not authorized, starting QR login");
        }
        Err(e) => {
            warn!(error = %e, "Failed to check authorization status, proceeding anyway");
        }
    }

    // Spawn background task for QR polling
    let cancel = CancellationToken::new();
    let session_key = SessionKey {
        user_id: auth.user_id.clone(),
        client_id: session_id,
    };

    tokio::spawn(qr_polling_loop(
        ctx.client.clone(),
        auth.id.clone(),
        tg_client,
        cancel.clone(),
        ctx.sessions.clone(),
        session_key,
    ));

    // Store the cancel token for potential cancellation
    {
        let mut polling_tasks = ctx.qr_polling_tasks.lock().await;
        polling_tasks.insert(auth.id.clone(), QrPollingHandle { cancel });
    }

    info!("QR polling task spawned");
    Ok(())
}

/// Get the Telegram user ID from an authorized client.
async fn get_telegram_user_id(tg_client: &TelegramClient) -> i64 {
    match tg_client.get_client_external_id().await {
        Ok(id) => {
            // Parse telegram:123456789 to extract the user_id
            id.strip_prefix("telegram:")
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0)
        }
        Err(e) => {
            warn!(error = %e, "Failed to get user_id");
            0
        }
    }
}

/// Background task that polls for QR login completion.
async fn qr_polling_loop(
    client: ConvexClient,
    auth_id: String,
    tg_client: Arc<TelegramClient>,
    cancel: CancellationToken,
    sessions: Arc<Mutex<HashMap<SessionKey, Arc<TelegramClient>>>>,
    session_key: SessionKey,
) {
    info!(auth_id = %auth_id, "Starting QR polling loop");

    let mut stream = std::pin::pin!(tg_client.login_with_qr());
    let mut last_token_url: Option<String> = None;

    loop {
        tokio::select! {
            biased;

            _ = cancel.cancelled() => {
                info!(auth_id = %auth_id, "QR polling cancelled");
                let mut sessions = sessions.lock().await;
                sessions.remove(&session_key);
                return;
            }
            result = stream.next() => {
                match result {
                    Some(Ok(QrLoginToken::Token { url, expires })) => {
                        // Only update if the token URL changed
                        if last_token_url.as_ref() == Some(&url) {
                            tracing::trace!(auth_id = %auth_id, "QR token unchanged, skipping update");
                            continue;
                        }

                        info!(auth_id = %auth_id, expires = expires, "New QR token generated");
                        last_token_url = Some(url.clone());

                        // Update auth row with new token via mutation
                        if let Err(e) = check_result(
                            client.clone().qr_auth_robot_update_qr_token(QrAuthRobotUpdateQrTokenArgs {
                                authId: auth_id.clone(),
                                url,
                                expires: f64::from(expires),
                            }).await,
                        ) {
                            error!(auth_id = %auth_id, error = %e, "Failed to update QR token");
                            // Continue polling - the update failure might be transient
                        }
                    }
                    Some(Ok(QrLoginToken::Success)) => {
                        info!(auth_id = %auth_id, "QR login successful");

                        let user_id = get_telegram_user_id(&tg_client).await;

                        if let Err(e) = check_result(
                            client.clone().qr_auth_robot_complete_qr_auth(QrAuthRobotCompleteQrAuthArgs {
                                authId: auth_id.clone(),
                                result: QrAuthRobotCompleteQrAuthResult::Authorized { userId: user_id },
                            }).await,
                        ) {
                            error!(auth_id = %auth_id, error = %e, "Failed to complete QR auth");
                        }

                        // Clean up the session from cache
                        let mut sessions = sessions.lock().await;
                        sessions.remove(&session_key);
                        return;
                    }
                    Some(Ok(QrLoginToken::MigrateTo { dc_id })) => {
                        info!(auth_id = %auth_id, dc_id = dc_id, "DC migration in progress");
                        // Migration is handled internally by grammers, continue polling
                    }
                    Some(Err(e)) => {
                        error!(auth_id = %auth_id, error = %e, "QR login error");

                        if let Err(e) = check_result(
                            client.clone().qr_auth_robot_complete_qr_auth(QrAuthRobotCompleteQrAuthArgs {
                                authId: auth_id.clone(),
                                result: QrAuthRobotCompleteQrAuthResult::Failed { error: e.to_string() },
                            }).await,
                        ) {
                            error!(auth_id = %auth_id, error = %e, "Failed to complete QR auth with error");
                        }

                        let mut sessions = sessions.lock().await;
                        sessions.remove(&session_key);
                        return;
                    }
                    None => {
                        warn!(auth_id = %auth_id, "QR login stream ended unexpectedly");

                        if let Err(e) = check_result(
                            client.clone().qr_auth_robot_complete_qr_auth(QrAuthRobotCompleteQrAuthArgs {
                                authId: auth_id.clone(),
                                result: QrAuthRobotCompleteQrAuthResult::Failed { error: "QR login stream ended unexpectedly".to_string() },
                            }).await,
                        ) {
                            error!(auth_id = %auth_id, error = %e, "Failed to complete QR auth");
                        }

                        let mut sessions = sessions.lock().await;
                        sessions.remove(&session_key);
                        return;
                    }
                }
            }
        }
    }
}
