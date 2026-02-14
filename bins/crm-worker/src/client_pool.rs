//! Process-local Telegram client cache.
//!
//! TelegramClient holds TCP connections and cannot be serialized into Restate state.
//! We cache them in a process-local DashMap keyed by (user_id, client_identifier).
//! On crash recovery, Restate replays the handler which rebuilds the client from
//! the `.session` file on disk.

use std::sync::Arc;

use dashmap::DashMap;
use messanger_telegram::TelegramClient;
use tracing::{info, instrument};

use crate::config::get_session_path;
use crate::error::WorkerError;

/// Key for identifying a Telegram client session.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub user_id: String,
    pub client_id: String,
}

/// Process-local cache of active Telegram client connections.
pub struct ClientPool {
    api_id: i32,
    api_hash: String,
    clients: DashMap<SessionKey, Arc<TelegramClient>>,
}

impl ClientPool {
    pub fn new(api_id: i32, api_hash: String) -> Self {
        Self {
            api_id,
            api_hash,
            clients: DashMap::new(),
        }
    }

    /// Get or create a Telegram client for the given user and client identifier.
    ///
    /// For phone login, `client_id` should be the phone number.
    /// For QR login, `client_id` should be the auth document ID.
    /// For scanning, `client_id` should be the Telegram external ID.
    #[instrument(skip(self), fields(user_id = %user_id, client_id = %client_id))]
    pub async fn get_or_create(
        &self,
        user_id: &str,
        client_id: &str,
    ) -> Result<Arc<TelegramClient>, WorkerError> {
        let key = SessionKey {
            user_id: user_id.to_string(),
            client_id: client_id.to_string(),
        };

        if let Some(client) = self.clients.get(&key) {
            tracing::debug!("Reusing existing Telegram client");
            return Ok(client.clone());
        }

        info!("Building new Telegram client");

        let session_path = get_session_path(client_id, user_id);

        let client = TelegramClient::new(
            self.api_id,
            self.api_hash.clone(),
            session_path.to_string_lossy().to_string(),
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to build Telegram client");
            WorkerError::ClientBuildFailed(e.to_string())
        })?;

        let client = Arc::new(client);
        self.clients.insert(key, client.clone());

        info!("Telegram client built successfully");
        Ok(client)
    }

    /// Remove a client from the pool.
    pub fn remove(&self, user_id: &str, client_id: &str) {
        let key = SessionKey {
            user_id: user_id.to_string(),
            client_id: client_id.to_string(),
        };
        self.clients.remove(&key);
    }
}
