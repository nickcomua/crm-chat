//! Auth execution logic for robot tasks.
//!
//! This module contains the actual business logic for executing auth steps
//! that have been assigned to this robot.

mod generate_qr_code;
mod send_login_code;
mod verify_login_code;
mod verify_password;

use std::collections::HashMap;
use std::sync::Arc;

use messanger_telegram::TelegramClient;
use sdb_api::module_bindings::{DbConnection, PhoneAuth, PhoneAuthStep, QrAuth, QrAuthStep};
use spacetimedb_sdk::Identity;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{info, instrument, warn};

use crate::config::TelegramConfig;
use crate::error::TaskError;

/// Key for identifying a Telegram client session.
/// Uses (user_id, client_identifier) where client_identifier is phone number or auth_id for QR.
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
    /// Active QR polling tasks keyed by qr_auth id
    pub qr_polling_tasks: Arc<Mutex<HashMap<u64, QrPollingHandle>>>,
}

/// Handle for a running QR polling task.
pub struct QrPollingHandle {
    pub cancel: CancellationToken,
}

impl TaskExecutionContext {
    /// Get or create a Telegram client for the given user and client identifier.
    ///
    /// For phone login, `client_id` should be the phone number.
    /// For QR login, `client_id` should be the auth_id (since we don't know the user_id yet).
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
            tracing::debug!("Reusing existing Telegram client");
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
            tracing::error!(error = %e, "Failed to build Telegram client");
            TaskError::ClientBuildFailed(e.to_string())
        })?;

        let client = Arc::new(client);
        sessions.insert(key, client.clone());

        info!("Telegram client built successfully");
        Ok(client)
    }

    /// Cancel QR polling for the given auth_id.
    pub async fn cancel_qr_polling(&self, auth_id: u64) {
        let mut polling_tasks = self.qr_polling_tasks.lock().await;
        if let Some(handle) = polling_tasks.remove(&auth_id) {
            info!(auth_id = auth_id, "Cancelling QR polling");
            handle.cancel.cancel();
        }
    }
}

/// Execute the current step of a phone auth flow.
#[instrument(skip(ctx), fields(auth_id = auth.id, step = ?auth.step))]
pub async fn execute_phone_auth(
    ctx: &TaskExecutionContext,
    auth: &PhoneAuth,
) -> Result<(), TaskError> {
    match auth.step {
        PhoneAuthStep::SendingCode => send_login_code::execute(ctx, auth).await,
        PhoneAuthStep::VerifyingCode => verify_login_code::execute(ctx, auth).await,
        PhoneAuthStep::VerifyingPassword => verify_password::execute(ctx, auth).await,
        _ => {
            warn!("Unexpected phone auth step for robot execution");
            Ok(())
        }
    }
}

/// Execute the current step of a QR auth flow.
#[instrument(skip(ctx), fields(auth_id = auth.id, step = ?auth.step))]
pub async fn execute_qr_auth(
    ctx: &TaskExecutionContext,
    auth: &QrAuth,
) -> Result<(), TaskError> {
    match auth.step {
        QrAuthStep::Generating => generate_qr_code::execute(ctx, auth).await,
        _ => {
            warn!("Unexpected QR auth step for robot execution");
            Ok(())
        }
    }
}
