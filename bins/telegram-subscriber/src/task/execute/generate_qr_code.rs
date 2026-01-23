//! Executor for GenerateQrCode task.
//!
//! This task generates QR code login tokens and polls for completion.

use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::{QrLoginToken, TelegramClient};
use sdb_api::module_bindings::{
    complete_task, update_task, DbConnection, GenerateQrCode, GenerateQrCodeOutput, QrToken,
    SignInSuccess, Task, TaskPayload,
};
use spacetimedb_sdk::{DbContext, Identity};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, instrument, warn};

use super::{QrPollingHandle, SessionKey, TaskExecutionContext};
use crate::error::TaskError;

/// Execute a GenerateQrCode task.
///
/// This will:
/// 1. Start the QR login flow
/// 2. Update the task with Token outputs as new QR codes are generated
/// 3. Complete the task when login succeeds or fails
///
/// Note: This spawns a background task for polling, so it returns quickly.
#[instrument(skip(ctx, task))]
pub async fn execute(
    ctx: &TaskExecutionContext,
    task: &Task,
    _payload: &GenerateQrCode,
) -> Result<(), TaskError> {
    info!("Executing GenerateQrCode task");

    // Cancel any existing QR polling task for this task_id and wait for cleanup
    {
        let mut polling_tasks = ctx.qr_polling_tasks.lock().await;
        if let Some(handle) = polling_tasks.remove(&task.id) {
            info!("Cancelling existing QR polling task");
            handle.cancel.cancel();
        }
    }

    // Use task_id as the session identifier for QR login
    // This ensures each QR login attempt has its own session file
    let session_id = task.id.clone();

    // Get or create Telegram client with task_id as identifier
    let tg_client = ctx
        .get_or_create_client(task.owner_user_id, &session_id)
        .await?;

    // Check if already authorized
    match tg_client.is_authorized().await {
        Ok(true) => {
            info!("Client is already authorized");
            // Get the user_id from the authorized client
            let user_id = get_telegram_user_id(&tg_client).await;
            complete_with_output(
                ctx,
                task,
                GenerateQrCodeOutput::AlreadyAuthorized(SignInSuccess { user_id }),
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
    let sessions = ctx.sessions.clone();
    let session_key = SessionKey {
        user_id: task.owner_user_id,
        client_id: session_id.clone(),
    };

    tokio::spawn(qr_polling_loop(
        ctx.conn.clone(),
        task.id.clone(),
        task.owner_user_id,
        tg_client,
        ctx.config.api_id,
        cancel.clone(),
        sessions,
        session_key,
    ));

    // Store the cancel token for potential cancellation
    {
        let mut polling_tasks = ctx.qr_polling_tasks.lock().await;
        polling_tasks.insert(task.id.clone(), QrPollingHandle { cancel });
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
    conn: Arc<DbConnection>,
    task_id: String,
    _owner_user_id: Identity,
    tg_client: Arc<TelegramClient>,
    api_id: i32,
    cancel: CancellationToken,
    sessions: Arc<Mutex<HashMap<SessionKey, Arc<TelegramClient>>>>,
    session_key: SessionKey,
) {
    info!(task_id = %task_id, "Starting QR polling loop");

    let mut stream = std::pin::pin!(tg_client.login_with_qr(api_id));
    let mut last_token_url: Option<String> = None;

    loop {
        tokio::select! {
            biased;

            _ = cancel.cancelled() => {
                info!(task_id = %task_id, "QR polling cancelled");
                // Clean up the session
                let mut sessions = sessions.lock().await;
                sessions.remove(&session_key);
                return;
            }
            result = stream.next() => {
                match result {
                    Some(Ok(QrLoginToken::Token { url, expires })) => {
                        // Only update if the token URL changed
                        if last_token_url.as_ref() == Some(&url) {
                            tracing::trace!(task_id = %task_id, "QR token unchanged, skipping update");
                            continue;
                        }

                        info!(task_id = %task_id, expires = expires, "New QR token generated");
                        last_token_url = Some(url.clone());

                        // Update task with new token (intermediate state)
                        let update_payload = TaskPayload::GenerateQrCode(GenerateQrCode {
                            output: GenerateQrCodeOutput::Token(QrToken { url, expires }),
                        });

                        if let Err(e) = conn.reducers().update_task(task_id.clone(), update_payload) {
                            error!(task_id = %task_id, error = %e, "Failed to update task with QR token");
                            // Continue polling - the update failure might be transient
                        }
                    }
                    Some(Ok(QrLoginToken::Success)) => {
                        info!(task_id = %task_id, "QR login successful");

                        // Get the user_id from the client
                        let user_id = get_telegram_user_id(&tg_client).await;

                        let complete_payload = TaskPayload::GenerateQrCode(GenerateQrCode {
                            output: GenerateQrCodeOutput::Authorized(SignInSuccess { user_id }),
                        });

                        if let Err(e) = conn.reducers().complete_task(task_id.clone(), complete_payload) {
                            error!(task_id = %task_id, error = %e, "Failed to complete QR login task");
                        }

                        // Clean up the session from cache (it will be re-loaded with proper phone-based key if needed)
                        let mut sessions = sessions.lock().await;
                        sessions.remove(&session_key);
                        return;
                    }
                    Some(Ok(QrLoginToken::MigrateTo { dc_id })) => {
                        info!(task_id = %task_id, dc_id = dc_id, "DC migration in progress");
                        // Migration is handled internally by grammers, continue polling
                    }
                    Some(Err(e)) => {
                        error!(task_id = %task_id, error = %e, "QR login error");

                        let complete_payload = TaskPayload::GenerateQrCode(GenerateQrCode {
                            output: GenerateQrCodeOutput::Failed(e.to_string()),
                        });

                        if let Err(e) = conn.reducers().complete_task(task_id.clone(), complete_payload) {
                            error!(task_id = %task_id, error = %e, "Failed to complete QR login task with error");
                        }

                        // Clean up the session
                        let mut sessions = sessions.lock().await;
                        sessions.remove(&session_key);
                        return;
                    }
                    None => {
                        warn!(task_id = %task_id, "QR login stream ended unexpectedly");

                        let complete_payload = TaskPayload::GenerateQrCode(GenerateQrCode {
                            output: GenerateQrCodeOutput::Failed(
                                "QR login stream ended unexpectedly".to_string(),
                            ),
                        });

                        if let Err(e) = conn.reducers().complete_task(task_id.clone(), complete_payload) {
                            error!(task_id = %task_id, error = %e, "Failed to complete QR login task");
                        }

                        // Clean up the session
                        let mut sessions = sessions.lock().await;
                        sessions.remove(&session_key);
                        return;
                    }
                }
            }
        }
    }
}

/// Complete the task with the given output.
fn complete_with_output(
    ctx: &TaskExecutionContext,
    task: &Task,
    output: GenerateQrCodeOutput,
) -> Result<(), TaskError> {
    let completed_payload = TaskPayload::GenerateQrCode(GenerateQrCode { output });

    ctx.conn
        .reducers()
        .complete_task(task.id.clone(), completed_payload)
        .map_err(|e| {
            error!(error = %e, "Failed to complete task");
            TaskError::ReducerFailed(e.to_string())
        })?;

    info!("Task completed successfully");
    Ok(())
}
