//! Executor for VerifyPassword task.
//!
//! This task verifies a 2FA password with Telegram.

use grammers_tl_types as tl;
use messanger_telegram::{CheckPasswordResult, ClonablePasswordToken};
use sdb_api::module_bindings::{
    complete_task, SignInSuccess, Task, TaskPayload, VerifyPassword, VerifyPasswordOutput,
};
use spacetimedb_sdk::DbContext;
use tracing::{error, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;

/// Execute a VerifyPassword task.
///
/// This will:
/// 1. Deserialize the password token from JSON
/// 2. Call check_password with the password
/// 3. Complete with Success, InvalidPassword, or Failed
#[instrument(skip(ctx, task, payload), fields(phone = %payload.client_phone))]
pub async fn execute(
    ctx: &TaskExecutionContext,
    task: &Task,
    payload: &VerifyPassword,
) -> Result<(), TaskError> {
    info!("Executing VerifyPassword task");

    // Get the Telegram client
    let tg_client = ctx
        .get_or_create_client(task.owner_user_id, &payload.client_phone)
        .await?;

    // Deserialize the password token from JSON
    let password_data: tl::types::account::Password =
        serde_json::from_str(&payload.token).map_err(|e| {
            error!(error = %e, "Failed to deserialize password token");
            TaskError::PasswordTokenInvalid(e.to_string())
        })?;

    let clonable_token = ClonablePasswordToken {
        hint: None, // Hint was already shown to user, not needed for verification
        password_data,
    };

    // Verify the password with timeout
    let check_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.check_password(clonable_token, &payload.password),
    )
    .await;

    let output = match check_result {
        Err(_) => {
            error!("Timeout verifying password");
            VerifyPasswordOutput::Failed("Timeout verifying password".to_string())
        }
        Ok(Err(e)) => {
            error!(error = %e, "Failed to verify password");
            VerifyPasswordOutput::Failed(format!("Failed to verify password: {}", e))
        }
        Ok(Ok(result)) => match result {
            CheckPasswordResult::Success { user_id } => {
                info!(user_id = user_id, "Password verification successful");
                VerifyPasswordOutput::Success(SignInSuccess { user_id })
            }
            CheckPasswordResult::InvalidPassword => {
                warn!("Invalid password");
                VerifyPasswordOutput::InvalidPassword
            }
        },
    };

    complete_with_output(ctx, task, payload, output)?;
    Ok(())
}

/// Complete the task with the given output.
fn complete_with_output(
    ctx: &TaskExecutionContext,
    task: &Task,
    payload: &VerifyPassword,
    output: VerifyPasswordOutput,
) -> Result<(), TaskError> {
    let completed_payload = TaskPayload::VerifyPassword(VerifyPassword {
        client_phone: payload.client_phone.clone(),
        password: payload.password.clone(),
        token: payload.token.clone(),
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
