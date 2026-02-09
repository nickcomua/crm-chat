//! Executor for SendingCode phone auth step.
//!
//! This step requests a login code from Telegram for the given phone number.

use messanger_interface::MessengerClient;
use sdb_api::module_bindings::{
    robot_complete_send_code, PhoneAuth, SendCodeResult, SendCodeSuccess,
};
use spacetimedb_sdk::DbContext;
use tracing::{error, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;

/// Execute the SendingCode step of a phone auth flow.
///
/// This will:
/// 1. Check if the client is already authorized
/// 2. If not, request a login code from Telegram
/// 3. Report the result via `robot_complete_send_code`
#[instrument(skip(ctx), fields(auth_id = auth.id, phone = %auth.phone))]
pub async fn execute(ctx: &TaskExecutionContext, auth: &PhoneAuth) -> Result<(), TaskError> {
    info!("Executing send_login_code");

    // Get or create Telegram client for this user
    let tg_client = ctx
        .get_or_create_client(auth.owner_user_id, &auth.phone)
        .await?;

    // Check if already authorized
    match tg_client.is_authorized().await {
        Ok(true) => {
            info!("Client is already authorized");
            ctx.conn
                .reducers()
                .robot_complete_send_code(auth.id, SendCodeResult::AlreadyAuthorized)
                .map_err(|e| TaskError::ReducerFailed(e.to_string()))?;
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
            SendCodeResult::Failed("Timeout requesting login code".to_string())
        }
        Ok(Err(e)) => {
            error!(error = %e, "Failed to request login code");
            SendCodeResult::Failed(format!("Failed to request login code: {}", e))
        }
        Ok(Ok(token)) => {
            info!("Login code requested successfully");
            SendCodeResult::Success(SendCodeSuccess {
                phone_code_hash: token.phone_code_hash,
            })
        }
    };

    ctx.conn
        .reducers()
        .robot_complete_send_code(auth.id, result)
        .map_err(|e| {
            error!(error = %e, "Failed to complete send_code");
            TaskError::ReducerFailed(e.to_string())
        })?;

    info!("send_login_code completed");
    Ok(())
}
