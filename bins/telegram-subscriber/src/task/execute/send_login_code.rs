//! Executor for SendLoginCode task.
//!
//! This task requests a login code from Telegram for the given phone number.

use messanger_interface::MessengerClient;
use sdb_api::module_bindings::{
    complete_task, LoginToken, SendLoginCode, SendLoginCodeOutput, Task, TaskPayload,
};
use spacetimedb_sdk::DbContext;
use tracing::{error, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;

/// Execute a SendLoginCode task.
///
/// This will:
/// 1. Check if the client is already authorized
/// 2. If not, request a login code from Telegram
/// 3. Complete the task with the result (Success with LoginToken, AlreadyAuthorized, or Failed)
#[instrument(skip(ctx, task), fields(phone = %payload.client_phone))]
pub async fn execute(
    ctx: &TaskExecutionContext,
    task: &Task,
    payload: &SendLoginCode,
) -> Result<(), TaskError> {
    info!("Executing SendLoginCode task");

    // Get or create Telegram client for this user
    let tg_client = ctx
        .get_or_create_client(task.owner_user_id, &payload.client_phone)
        .await?;

    // Check if already authorized
    match tg_client.is_authorized().await {
        Ok(true) => {
            info!("Client is already authorized");
            complete_with_output(
                ctx,
                task,
                payload,
                SendLoginCodeOutput::AlreadyAuthorized,
            )?;
            return Ok(());
        }
        Ok(false) => {
            info!("Client is not authorized, requesting login code");
        }
        Err(e) => {
            warn!(error = %e, "Failed to check authorization status, proceeding anyway");
        }
    }

    // Request login code with timeout
    let code_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.request_login_code(&payload.client_phone),
    )
    .await;

    let output = match code_result {
        Err(_) => {
            error!("Timeout requesting login code");
            SendLoginCodeOutput::Failed("Timeout requesting login code".to_string())
        }
        Ok(Err(e)) => {
            error!(error = %e, "Failed to request login code");
            SendLoginCodeOutput::Failed(format!("Failed to request login code: {}", e))
        }
        Ok(Ok(token)) => {
            info!("Login code requested successfully");
            SendLoginCodeOutput::Success(LoginToken {
                phone: token.phone,
                phone_code_hash: token.phone_code_hash,
            })
        }
    };

    complete_with_output(ctx, task, payload, output)?;
    Ok(())
}

/// Complete the task with the given output.
fn complete_with_output(
    ctx: &TaskExecutionContext,
    task: &Task,
    payload: &SendLoginCode,
    output: SendLoginCodeOutput,
) -> Result<(), TaskError> {
    let completed_payload = TaskPayload::SendLoginCode(SendLoginCode {
        client_phone: payload.client_phone.clone(),
        output,
    });

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
