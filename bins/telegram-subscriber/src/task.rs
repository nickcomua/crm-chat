//! Auth processing module for the telegram-subscriber robot.
//!
//! This module handles:
//! - Claiming unassigned phone_auth and qr_auth sessions
//! - Executing assigned auth steps by calling Telegram APIs
//! - Scanning connected clients for chats and messages

mod execute;
pub mod scan;

use convex::ConvexClient;
use convex_backend::PhoneAuthRobotClaimArgs;
use convex_backend::QrAuthRobotClaimArgs;
use tracing::{error, info, instrument};

use crate::error::TaskError;
use crate::types::{ConvexApi, check_result};

// Re-export execute functions
pub use execute::{TaskExecutionContext, execute_phone_auth, execute_qr_auth};

/// Claim an unassigned phone auth session via Convex mutation.
#[instrument(skip(client))]
pub async fn claim_phone_auth(client: &ConvexClient, auth_id: &str) -> Result<(), TaskError> {
    info!("Claiming phone auth");
    check_result(
        client
            .clone()
            .phone_auth_robot_claim(PhoneAuthRobotClaimArgs {
                authId: auth_id.into(),
            })
            .await,
    )
    .map_err(|e| {
        error!(error = %e, "Failed to claim phone auth");
        e
    })
}

/// Claim an unassigned QR auth session via Convex mutation.
#[instrument(skip(client))]
pub async fn claim_qr_auth(client: &ConvexClient, auth_id: &str) -> Result<(), TaskError> {
    info!("Claiming QR auth");
    check_result(
        client
            .clone()
            .qr_auth_robot_claim(QrAuthRobotClaimArgs {
                authId: auth_id.into(),
            })
            .await,
    )
    .map_err(|e| {
        error!(error = %e, "Failed to claim QR auth");
        e
    })
}
