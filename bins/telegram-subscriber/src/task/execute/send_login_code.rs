//! Executor for SendingCode phone auth step.
//!
//! This step requests a login code from Telegram for the given phone number.

use convex_backend::{PhoneAuthRobotCompleteSendCodeArgs, PhoneAuthRobotCompleteSendCodeResult};
use messanger_interface::MessengerClient;
use tracing::{error, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;
use crate::types::{check_result, ConvexApi, PhoneAuth};

/// Execute the SendingCode step of a phone auth flow.
///
/// This will:
/// 1. Check if the client is already authorized
/// 2. If not, request a login code from Telegram
/// 3. Report the result via `phoneAuth:robotCompleteSendCode`
#[instrument(skip(ctx), fields(auth_id = %auth.id, phone = %auth.phone))]
pub async fn execute(ctx: &TaskExecutionContext, auth: &PhoneAuth) -> Result<(), TaskError> {
    info!("Executing send_login_code");

    // Get or create Telegram client for this user
    let tg_client = ctx
        .get_or_create_client(&auth.user_id, &auth.phone)
        .await?;

    // Check if already authorized
    match tg_client.is_authorized().await {
        Ok(true) => {
            info!("Client is already authorized");
            check_result(
                ctx.client
                    .clone()
                    .phone_auth_robot_complete_send_code(PhoneAuthRobotCompleteSendCodeArgs {
                        authId: auth.id.clone(),
                        result: PhoneAuthRobotCompleteSendCodeResult::AlreadyAuthorized,
                    })
                    .await,
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
        tg_client.request_login_code(&auth.phone),
    )
    .await;

    let result = match code_result {
        Err(_) => {
            error!("Timeout requesting login code");
            PhoneAuthRobotCompleteSendCodeResult::Failed {
                error: "Timeout requesting login code".to_string(),
            }
        }
        Ok(Err(e)) => {
            error!(error = %e, "Failed to request login code");
            PhoneAuthRobotCompleteSendCodeResult::Failed {
                error: format!("Failed to request login code: {}", e),
            }
        }
        Ok(Ok(token)) => {
            info!("Login code requested successfully");
            PhoneAuthRobotCompleteSendCodeResult::Success {
                phoneCodeHash: token.phone_code_hash,
            }
        }
    };

    check_result(
        ctx.client
            .clone()
            .phone_auth_robot_complete_send_code(PhoneAuthRobotCompleteSendCodeArgs {
                authId: auth.id.clone(),
                result,
            })
            .await,
    )
    .inspect_err(|e| error!(error = %e, "Failed to complete send_code"))?;

    info!("send_login_code completed");
    Ok(())
}
