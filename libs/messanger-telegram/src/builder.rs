//! Builder for creating TelegramClient instances.

use std::sync::Arc;

use async_trait::async_trait;
use grammers_client::Client;
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use messanger_interface::{
    session::SessionStoreWrapper, AuthConfig, MessengerClientBuilder, MessengerError, SessionStore,
};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, instrument};

use crate::TelegramClient;

/// Builder for creating Telegram clients.
pub struct TelegramClientBuilder;

impl TelegramClientBuilder {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl MessengerClientBuilder for TelegramClientBuilder {
    type Client = TelegramClient;

    #[instrument(skip(self, auth_config, session_store))]
    async fn build(
        &self,
        auth_config: AuthConfig,
        session_store: Option<Box<dyn SessionStore>>,
    ) -> Result<Self::Client, MessengerError> {
        info!("Building TelegramClient");

        let api_id = auth_config
            .credentials
            .get("api_id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| {
                error!("Missing api_id in credentials");
                MessengerError::Authentication("Missing api_id in credentials".to_string())
            })? as i32;

        debug!(api_id = api_id, "Got API ID");

        // Create or load session
        let session = if let Some(store) = &session_store {
            debug!("Loading session from store");
            if let Some(session_json) = store.load().await? {
                let session_file = session_json
                    .get("session_file")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        error!("Missing session_file field in session data");
                        MessengerError::Serialization("Missing session_file field".to_string())
                    })?;
                debug!(session_file = %session_file, "Opening session file");
                let session = SqliteSession::open(session_file).map_err(|e| {
                    error!(error = %e, "Failed to open session file");
                    MessengerError::Session(format!("Failed to open session: {}", e))
                })?;
                session
            } else {
                error!("Session not found in store");
                return Err(MessengerError::Session("Session not found".to_string()));
            }
        } else {
            error!("Session store not provided");
            return Err(MessengerError::Session(
                "Session store not provided".to_string(),
            ));
        };

        debug!("Creating sender pool");
        let session = Arc::new(session);
        let mut pool = SenderPool::new(session.clone(), api_id);

        // Extract the updates receiver before creating the client
        // We need to replace it with a dummy channel since Client::new needs to borrow the pool
        debug!("Setting up updates channel");
        let (dummy_tx, dummy_rx) = mpsc::unbounded_channel();
        let updates_rx = std::mem::replace(&mut pool.updates, dummy_rx);
        drop(dummy_tx); // Close the dummy channel immediately
        let updates_rx = Arc::new(Mutex::new(Some(updates_rx)));

        debug!("Creating client");
        let client = Client::new(&pool);
        let pool_runner_handle = tokio::spawn(pool.runner.run());

        // Store the session store if provided
        let stored_session_store = session_store
            .map(|s| Arc::new(SessionStoreWrapper(s)) as Arc<dyn SessionStore + Send + Sync>);

        debug!("Checking authorization");
        client.is_authorized().await.map_err(|e| {
            error!(error = %e, "Failed to check authorization");
            MessengerError::Connection(format!("Failed to check authorization: {}", e))
        })?;

        let api_hash = auth_config
            .credentials
            .get("api_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                error!("Missing api_hash in credentials");
                MessengerError::Authentication("Missing api_hash in credentials".to_string())
            })?
            .to_string();

        info!("TelegramClient built successfully");
        Ok(TelegramClient {
            client: Arc::new(Mutex::new(client)),
            session,
            api_hash,
            session_store: stored_session_store,
            updates_rx,
            pool_runner_handle,
        })
    }
}

impl Default for TelegramClientBuilder {
    fn default() -> Self {
        Self::new()
    }
}
