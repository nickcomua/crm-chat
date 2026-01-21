//! Telegram messenger client implementation for the universal messenger interface.
//!
//! This crate provides a Telegram-specific implementation of the `MessengerClient`
//! trait using the `grammers-client` library.

mod auth;
mod builder;
mod messenger;

use std::sync::Arc;

use grammers_client::Client;
use grammers_session::storages::SqliteSession;
use grammers_session::updates::UpdatesLike;
use messanger_interface::SessionStore;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

// Re-export public types
pub use auth::{
    CheckPasswordResult, ClonableLoginToken, ClonablePasswordToken, QrLoginToken, SignInResult,
};
pub use builder::TelegramClientBuilder;

/// Telegram client implementation of the MessengerClient trait.
pub struct TelegramClient {
    pub client: Arc<Mutex<Client>>,
    #[allow(dead_code)]
    pub session: Arc<SqliteSession>,
    pub api_hash: String,
    #[allow(dead_code)]
    pub session_store: Option<Arc<dyn SessionStore + Send + Sync>>,
    pub updates_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<UpdatesLike>>>>,
    #[allow(dead_code)]
    pub pool_runner_handle: JoinHandle<()>,
}

impl TelegramClient {
    /// Get access to the underlying grammers Client for advanced operations
    /// like sending, editing, and deleting messages.
    pub async fn get_native_client(&self) -> Arc<Mutex<Client>> {
        self.client.clone()
    }
}
