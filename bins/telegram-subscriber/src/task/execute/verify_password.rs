//! Executor for VerifyingPassword phone auth step.
//!
//! This step verifies a 2FA password with Telegram.

use convex_backend::{PhoneAuthRobotCompleteVerifyPasswordArgs, PhoneAuthRobotCompleteVerifyPasswordResult};
use grammers_tl_types as tl;
use messanger_telegram::{CheckPasswordResult, ClonablePasswordToken};
use tracing::{error, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;
use crate::types::{check_result, ConvexApi, PhoneAuth};

/// Execute the VerifyingPassword step of a phone auth flow.
///
/// This will:
/// 1. Read the password_token and password from the PhoneAuth document
/// 2. Call check_password with the password
/// 3. Report the result via `phoneAuth:robotCompleteVerifyPassword`
#[instrument(skip(ctx, auth), fields(auth_id = %auth.id, phone = %auth.phone))]
pub async fn execute(ctx: &TaskExecutionContext, auth: &PhoneAuth) -> Result<(), TaskError> {
    info!("Executing verify_password");

    // Get the Telegram client
    let tg_client = ctx
        .get_or_create_client(&auth.user_id, &auth.phone)
        .await?;

    // Read auth secrets from the PhoneAuth document
    let password_token_str = auth.password_token.as_ref().ok_or_else(|| {
        TaskError::PasswordTokenInvalid("password_token not set on PhoneAuth row".to_string())
    })?;
    let password = auth.password.as_ref().ok_or_else(|| {
        TaskError::MutationFailed("password not set on PhoneAuth row".to_string())
    })?;

    // Deserialize the password token from JSON
    let password_data: tl::types::account::Password =
        serde_json::from_str(password_token_str).map_err(|e| {
            error!(error = %e, "Failed to deserialize password token");
            TaskError::PasswordTokenInvalid(e.to_string())
        })?;

    let clonable_token = ClonablePasswordToken {
        hint: None, // Hint was already shown to user, not needed for verification
        password_data,
    };

    // Verify the password with timeout
    let check_result_val = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.check_password(clonable_token, password),
    )
    .await;

    let result = match check_result_val {
        Err(_) => {
            error!("Timeout verifying password");
            PhoneAuthRobotCompleteVerifyPasswordResult::Failed {
                error: "Timeout verifying password".to_string(),
            }
        }
        Ok(Err(e)) => {
            error!(error = %e, "Failed to verify password");
            PhoneAuthRobotCompleteVerifyPasswordResult::Failed {
                error: format!("Failed to verify password: {}", e),
            }
        }
        Ok(Ok(r)) => match r {
            CheckPasswordResult::Success { user_id } => {
                info!(user_id = user_id, "Password verification successful");
                PhoneAuthRobotCompleteVerifyPasswordResult::Success { userId: user_id }
            }
            CheckPasswordResult::InvalidPassword => {
                warn!("Invalid password");
                PhoneAuthRobotCompleteVerifyPasswordResult::InvalidPassword
            }
        },
    };

    check_result(
        ctx.client
            .clone()
            .phone_auth_robot_complete_verify_password(
                PhoneAuthRobotCompleteVerifyPasswordArgs {
                    authId: auth.id.clone(),
                    result,
                },
            )
            .await,
    )
    .inspect_err(|e| error!(error = %e, "Failed to complete verify_password"))?;

    info!("verify_password completed");
    Ok(())
}
