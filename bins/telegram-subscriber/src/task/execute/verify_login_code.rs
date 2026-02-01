//! Executor for VerifyLoginCode task.
//!
//! This task verifies a login code with Telegram.

use messanger_telegram::{ClonableLoginToken, SignInResult};
use sdb_api::module_bindings::{
    PasswordToken, SignInSuccess, Task, TaskPayload, VerifyLoginCode, VerifyLoginCodeOutput,
    complete_task,
};
use spacetimedb_sdk::DbContext;
use tracing::{error, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;

/// Execute a VerifyLoginCode task.
///
/// This will:
/// 1. Look up the LoginToken from the completed SendLoginCode task
/// 2. Call sign_in with the code
/// 3. Complete with Success, PasswordRequired, InvalidCode, SignUpRequired, or Failed
#[instrument(skip(ctx, task), fields(phone = %payload.client_phone))]
pub async fn execute(
    ctx: &TaskExecutionContext,
    task: &Task,
    payload: &VerifyLoginCode,
) -> Result<(), TaskError> {
    info!("Executing VerifyLoginCode task");

    // Get the Telegram client
    let tg_client = ctx
        .get_or_create_client(task.owner_user_id, &payload.client_phone)
        .await?;

    // Get the LoginToken directly from the task payload
    let clonable_token = ClonableLoginToken {
        phone: payload.token.phone.clone(),
        phone_code_hash: payload.token.phone_code_hash.clone(),
    };

    // Verify the code with timeout
    let sign_in_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.sign_in(&clonable_token, &payload.code),
    )
    .await;

    let output = match sign_in_result {
        Err(_) => {
            error!("Timeout verifying login code");
            VerifyLoginCodeOutput::Failed("Timeout verifying login code".to_string())
        }
        Ok(Err(e)) => {
            error!(error = %e, "Failed to verify login code");
            VerifyLoginCodeOutput::Failed(format!("Failed to verify login code: {}", e))
        }
        Ok(Ok(result)) => match result {
            SignInResult::Success { user_id } => {
                info!(user_id = user_id, "Sign in successful");
                VerifyLoginCodeOutput::Success(SignInSuccess { user_id })
            }
            SignInResult::PasswordRequired(password_token) => {
                info!("2FA password required");
                // Serialize the password_data to JSON for storage
                let token_json =
                    serde_json::to_string(&password_token.password_data).map_err(|e| {
                        error!(error = %e, "Failed to serialize password token");
                        TaskError::Serialization(e.to_string())
                    })?;

                VerifyLoginCodeOutput::PasswordRequired(PasswordToken {
                    hint: password_token.hint,
                    token: token_json,
                })
            }
            SignInResult::InvalidCode => {
                warn!("Invalid login code");
                VerifyLoginCodeOutput::InvalidCode
            }
            SignInResult::SignUpRequired => {
                warn!("Sign up required - account does not exist");
                VerifyLoginCodeOutput::SignUpRequired
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
    payload: &VerifyLoginCode,
    output: VerifyLoginCodeOutput,
) -> Result<(), TaskError> {
    let completed_payload = TaskPayload::VerifyLoginCode(VerifyLoginCode {
        client_phone: payload.client_phone.clone(),
        token: payload.token.clone(),
        code: payload.code.clone(),
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
