//! Telegram messenger client implementation for the universal messenger interface.
//!
//! This crate provides a Telegram-specific implementation of the `MessengerClient`
//! trait using the `grammers-client` library.

mod auth;
mod messenger;

use std::sync::Arc;

use grammers_client::Client;
use grammers_session::storages::SqliteSession;
use grammers_session::updates::UpdatesLike;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

// Re-export public types
pub use auth::{
    CheckPasswordResult, ClonableLoginToken, ClonablePasswordToken, QrLoginToken, SignInResult,
};

/// Telegram client implementation of the MessengerClient trait.
pub struct TelegramClient {
    pub client: Arc<Mutex<Client>>,
    #[allow(dead_code)]
    pub session: Arc<SqliteSession>,
    pub api_id: i32,
    pub api_hash: String,
    pub updates_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<UpdatesLike>>>>,
    #[allow(dead_code)]
    pub pool_runner_handle: JoinHandle<()>,
}

impl TelegramClient {
    /// Create a new TelegramClient with the given configuration.
    pub async fn new(
        api_id: i32,
        api_hash: String,
        session_file: String,
    ) -> Result<Self, messanger_interface::MessengerError> {
        use grammers_client::Client;
        use grammers_mtsender::SenderPool;
        use grammers_session::storages::SqliteSession;
        use messanger_interface::MessengerError;
        use tracing::{debug, error, info};

        info!("Building TelegramClient");

        debug!(api_id = api_id, "Got API ID");
        debug!(session_file = %session_file, "Opening session file");

        // Open session file
        let session = SqliteSession::open(&session_file).map_err(|e| {
            error!(error = %e, "Failed to open session file");
            MessengerError::Session(format!("Failed to open session: {}", e))
        })?;

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

        debug!("Checking authorization");
        client.is_authorized().await.map_err(|e| {
            error!(error = %e, "Failed to check authorization");
            MessengerError::Connection(format!("Failed to check authorization: {}", e))
        })?;

        info!("TelegramClient built successfully");
        Ok(TelegramClient {
            client: Arc::new(Mutex::new(client)),
            session,
            api_id,
            api_hash,
            updates_rx,
            pool_runner_handle,
        })
    }

    /// Get access to the underlying grammers Client for advanced operations
    /// like sending, editing, and deleting messages.
    pub async fn get_native_client(&self) -> Arc<Mutex<Client>> {
        self.client.clone()
    }
}
