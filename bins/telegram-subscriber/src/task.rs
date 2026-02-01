//! Task processing module for the telegram-subscriber robot.
//!
//! This module handles:
//! - Identifying which tasks are robot tasks vs user tasks
//! - Picking (assigning) unassigned robot tasks
//! - Executing assigned tasks by calling Telegram APIs

mod execute;

use sdb_api::module_bindings::{assign_task, DbConnection, Task, TaskPayload, TaskStatus};
use spacetimedb_sdk::{DbContext, Identity};
use tracing::{debug, error, info, instrument, warn};

use crate::error::TaskError;

/// Check if a task payload is a robot task (should be processed by telegram-subscriber).
///
/// Robot tasks involve calling Telegram APIs:
/// - SendLoginCode: Request login code from Telegram
/// - VerifyLoginCode: Verify the code with Telegram
/// - VerifyPassword: Check 2FA password with Telegram
/// - GenerateQrCode: Generate and poll QR code login
///
/// User tasks are completed by the frontend:
/// - ReceiveLoginCode: User enters the code they received
/// - ReceivePassword: User enters their 2FA password
/// - DisplayMessage: User dismisses a message
pub fn is_robot_task(payload: &TaskPayload) -> bool {
    matches!(
        payload,
        TaskPayload::SendLoginCode(_)
            | TaskPayload::VerifyLoginCode(_)
            | TaskPayload::VerifyPassword(_)
            | TaskPayload::GenerateQrCode(_)
    )
}

/// Attempt to pick (assign) an unassigned robot task.
///
/// This function only claims ownership of the task - it does NOT execute any business logic.
/// The actual execution happens when we receive the task back with `Assigned(my_identity)` status.
///
/// # Arguments
/// * `conn` - SpacetimeDB connection
/// * `task` - The task to potentially pick
/// * `my_identity` - This robot's identity
///
/// # Returns
/// * `Ok(true)` - Task was successfully picked
/// * `Ok(false)` - Task was not picked (not unassigned or not a robot task)
/// * `Err(_)` - Failed to call assign_task reducer
#[instrument(skip(conn), fields(task_id = %task.id))]
pub fn pick_task(
    conn: &DbConnection,
    task: &Task,
    my_identity: Identity,
) -> Result<bool, TaskError> {
    // Only pick unassigned tasks
    if !matches!(task.status, TaskStatus::Unassigned) {
        debug!("Task is not unassigned, skipping");
        return Ok(false);
    }

    // Only pick robot tasks
    if !is_robot_task(&task.payload) {
        debug!("Task is not a robot task, skipping");
        return Ok(false);
    }

    info!(
        task_type = ?std::mem::discriminant(&task.payload),
        "Picking unassigned robot task"
    );

    // Claim the task
    conn.reducers().assign_task(task.id.clone()).map_err(|e| {
        error!(error = %e, "Failed to assign task");
        TaskError::ReducerFailed(e.to_string())
    })?;

    info!("Task assigned successfully");
    Ok(true)
}

// Re-export execute functions
pub use execute::{execute_task, TaskExecutionContext};
