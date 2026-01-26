//! Task execution logic for robot tasks.
//!
//! This module contains the actual business logic for executing tasks
//! that have been assigned to this robot.

mod generate_qr_code;
mod send_login_code;
mod verify_login_code;
mod verify_password;

use std::collections::HashMap;
use std::sync::Arc;

use messanger_telegram::TelegramClient;
use sdb_api::module_bindings::{DbConnection, Task, TaskPayload, TaskStatus};
use spacetimedb_sdk::Identity;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, instrument, warn};

use crate::config::TelegramConfig;
use crate::error::TaskError;

/// Key for identifying a Telegram client session.
/// Uses (user_id, client_identifier) where client_identifier is phone number or task_id for QR.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub user_id: Identity,
    pub client_id: String,
}

/// Context needed for task execution.
pub struct TaskExecutionContext {
    /// SpacetimeDB connection
    pub conn: Arc<DbConnection>,
    /// This robot's identity
    pub my_identity: Identity,
    /// Telegram configuration (api_id, api_hash)
    pub config: TelegramConfig,
    /// Active Telegram client sessions keyed by (user_id, client_identifier)
    pub sessions: Arc<Mutex<HashMap<SessionKey, Arc<TelegramClient>>>>,
    /// Active QR polling tasks keyed by task_id
    pub qr_polling_tasks: Arc<Mutex<HashMap<String, QrPollingHandle>>>,
}

/// Handle for a running QR polling task.
pub struct QrPollingHandle {
    pub cancel: CancellationToken,
}

impl TaskExecutionContext {
    /// Get or create a Telegram client for the given user and client identifier.
    ///
    /// For phone login, `client_id` should be the phone number.
    /// For QR login, `client_id` should be the task_id (since we don't know the user_id yet).
    #[instrument(skip(self), fields(user_id = %user_id, client_id = %client_id))]
    pub async fn get_or_create_client(
        &self,
        user_id: Identity,
        client_id: &str,
    ) -> Result<Arc<TelegramClient>, TaskError> {
        let key = SessionKey {
            user_id,
            client_id: client_id.to_string(),
        };

        let mut sessions = self.sessions.lock().await;

        if let Some(client) = sessions.get(&key) {
            debug!("Reusing existing Telegram client");
            return Ok(client.clone());
        }

        info!("Building new Telegram client");

        let session_path = crate::config::get_session_path(client_id, &user_id.to_string());

        let client = TelegramClient::new(
            self.config.api_id,
            self.config.api_hash.clone(),
            session_path.to_string_lossy().to_string(),
        )
        .await
        .map_err(|e| {
            error!(error = %e, "Failed to build Telegram client");
            TaskError::ClientBuildFailed(e.to_string())
        })?;

        let client = Arc::new(client);
        sessions.insert(key, client.clone());

        info!("Telegram client built successfully");
        Ok(client)
    }

    /// Remove a session from the cache.
    pub async fn remove_session(&self, user_id: Identity, client_id: &str) {
        let key = SessionKey {
            user_id,
            client_id: client_id.to_string(),
        };
        let mut sessions = self.sessions.lock().await;
        sessions.remove(&key);
    }
}

/// Execute an assigned robot task.
///
/// This function should only be called for tasks that:
/// 1. Are assigned to this robot (`TaskStatus::Assigned(my_identity)`)
/// 2. Are robot tasks (SendLoginCode, VerifyLoginCode, VerifyPassword, GenerateQrCode)
///
/// The function will call the appropriate Telegram API and complete/update the task.
///
/// # Arguments
/// * `ctx` - Task execution context
/// * `task` - The task to execute
///
/// # Returns
/// * `Ok(())` - Task was executed (success or failure is recorded in the task)
/// * `Err(_)` - Failed to execute (e.g., couldn't build client, reducer call failed)
#[instrument(skip(ctx), fields(task_id = %task.id, task_type = ?std::mem::discriminant(&task.payload)))]
pub async fn execute_task(ctx: &TaskExecutionContext, task: &Task) -> Result<(), TaskError> {
    // Verify task is assigned to us
    match &task.status {
        TaskStatus::Assigned(robot_id) if *robot_id == ctx.my_identity => {
            debug!("Task is assigned to us, proceeding with execution");
        }
        _ => {
            warn!("Task is not assigned to us, skipping execution");
            return Err(TaskError::NotAssignedToMe);
        }
    }

    // Dispatch to appropriate executor based on payload type
    match &task.payload {
        TaskPayload::SendLoginCode(payload) => {
            send_login_code::execute(ctx, task, payload).await
        }
        TaskPayload::VerifyLoginCode(payload) => {
            verify_login_code::execute(ctx, task, payload).await
        }
        TaskPayload::VerifyPassword(payload) => {
            verify_password::execute(ctx, task, payload).await
        }
        TaskPayload::GenerateQrCode(payload) => {
            generate_qr_code::execute(ctx, task, payload).await
        }
        // User tasks should never be executed by the robot
        TaskPayload::ReceiveLoginCode(_)
        | TaskPayload::ReceivePassword(_)
        | TaskPayload::DisplayMessage(_) => {
            warn!("Attempted to execute user task as robot task");
            Err(TaskError::NotRobotTask)
        }
    }
}
