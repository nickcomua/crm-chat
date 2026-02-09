//! Auth processing module for the telegram-subscriber robot.
//!
//! This module handles:
//! - Claiming unassigned phone_auth and qr_auth sessions
//! - Executing assigned auth steps by calling Telegram APIs

mod execute;

use sdb_api::module_bindings::{robot_claim_phone_auth, robot_claim_qr_auth, DbConnection};
use spacetimedb_sdk::DbContext;
use tracing::{error, info, instrument};

use crate::error::TaskError;

/// Claim an unassigned phone auth session.
#[instrument(skip(conn))]
pub fn claim_phone_auth(conn: &DbConnection, auth_id: u64) -> Result<(), TaskError> {
    info!("Claiming phone auth");
    conn.reducers()
        .robot_claim_phone_auth(auth_id)
        .map_err(|e| {
            error!(error = %e, "Failed to claim phone auth");
            TaskError::ReducerFailed(e.to_string())
        })
}

/// Claim an unassigned QR auth session.
#[instrument(skip(conn))]
pub fn claim_qr_auth(conn: &DbConnection, auth_id: u64) -> Result<(), TaskError> {
    info!("Claiming QR auth");
    conn.reducers()
        .robot_claim_qr_auth(auth_id)
        .map_err(|e| {
            error!(error = %e, "Failed to claim QR auth");
            TaskError::ReducerFailed(e.to_string())
        })
}

// Re-export execute functions
pub use execute::{execute_phone_auth, execute_qr_auth, TaskExecutionContext};
