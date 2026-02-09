//! Executor for VerifyingCode phone auth step.
//!
//! This step verifies a login code with Telegram.

use messanger_telegram::{ClonableLoginToken, SignInResult};
use sdb_api::module_bindings::{
    robot_complete_verify_code, PasswordRequiredInfo, PhoneAuth, VerifyCodeResult,
    VerifyCodeSuccess,
};
use spacetimedb_sdk::DbContext;
use tracing::{error, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;

/// Execute the VerifyingCode step of a phone auth flow.
///
/// This will:
/// 1. Read the phone_code_hash and login_code from the PhoneAuth row
/// 2. Call sign_in with the code
/// 3. Report the result via `robot_complete_verify_code`
#[instrument(skip(ctx), fields(auth_id = auth.id, phone = %auth.phone))]
pub async fn execute(ctx: &TaskExecutionContext, auth: &PhoneAuth) -> Result<(), TaskError> {
    info!("Executing verify_login_code");

    // Get the Telegram client
    let tg_client = ctx
        .get_or_create_client(auth.owner_user_id, &auth.phone)
        .await?;

    // Read auth secrets from the PhoneAuth row (no frontend round-trip needed)
    let phone_code_hash = auth.phone_code_hash.as_ref().ok_or_else(|| {
        TaskError::ReducerFailed("phone_code_hash not set on PhoneAuth row".to_string())
    })?;
    let login_code = auth.login_code.as_ref().ok_or_else(|| {
        TaskError::ReducerFailed("login_code not set on PhoneAuth row".to_string())
    })?;

    let clonable_token = ClonableLoginToken {
        phone: auth.phone.clone(),
        phone_code_hash: phone_code_hash.clone(),
    };

    // Verify the code with timeout
    let sign_in_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.sign_in(&clonable_token, login_code),
    )
    .await;

    let result = match sign_in_result {
        Err(_) => {
            error!("Timeout verifying login code");
            VerifyCodeResult::Failed("Timeout verifying login code".to_string())
        }
        Ok(Err(e)) => {
            error!(error = %e, "Failed to verify login code");
            VerifyCodeResult::Failed(format!("Failed to verify login code: {}", e))
        }
        Ok(Ok(r)) => match r {
            SignInResult::Success { user_id } => {
                info!(user_id = user_id, "Sign in successful");
                VerifyCodeResult::Success(VerifyCodeSuccess { user_id })
            }
            SignInResult::PasswordRequired(password_token) => {
                info!("2FA password required");
                // Serialize the password token for storage in SpacetimeDB
                let token_json =
                    serde_json::to_string(&password_token.password_data).map_err(|e| {
                        error!(error = %e, "Failed to serialize password token");
                        TaskError::Serialization(e.to_string())
                    })?;

                VerifyCodeResult::PasswordRequired(PasswordRequiredInfo {
                    hint: password_token.hint,
                    password_token: token_json,
                })
            }
            SignInResult::InvalidCode => {
                warn!("Invalid login code");
                VerifyCodeResult::InvalidCode
            }
            SignInResult::SignUpRequired => {
                warn!("Sign up required - account does not exist");
                VerifyCodeResult::SignUpRequired
            }
        },
    };

    ctx.conn
        .reducers()
        .robot_complete_verify_code(auth.id, result)
        .map_err(|e| {
            error!(error = %e, "Failed to complete verify_code");
            TaskError::ReducerFailed(e.to_string())
        })?;

    info!("verify_login_code completed");
    Ok(())
}
