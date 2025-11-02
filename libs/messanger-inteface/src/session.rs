//! Session persistence traits and types.

use async_trait::async_trait;
use serde_json::Value as JsonValue;

use crate::error::MessengerError;

/// Session persistence trait for saving and loading authentication state.
#[async_trait]
pub trait SessionStore: Send + Sync {
    /// Load session data (returns None if no session exists).
    async fn load(&self) -> Result<Option<JsonValue>, MessengerError>;

    /// Save session data.
    async fn save(&self, session: &JsonValue) -> Result<(), MessengerError>;

    /// Delete stored session data.
    async fn delete(&self) -> Result<(), MessengerError>;
}

