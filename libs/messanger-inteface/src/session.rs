//! Session persistence traits and types.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;

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

#[derive(Clone, Default)]
pub struct JsonSessionStore {
    data: Arc<Mutex<Option<JsonValue>>>,
}

impl JsonSessionStore {
    pub fn new(data: JsonValue) -> Self {
        Self {
            data: Arc::new(Mutex::new(Some(data))),
        }
    }
}

#[async_trait]
impl SessionStore for JsonSessionStore {
    async fn load(&self) -> Result<Option<JsonValue>, MessengerError> {
        Ok(self.data.lock().await.clone())
    }

    async fn save(&self, session: &JsonValue) -> Result<(), MessengerError> {
        *self.data.lock().await = Some(session.clone());
        Ok(())
    }

    async fn delete(&self) -> Result<(), MessengerError> {
        *self.data.lock().await = None;
        Ok(())
    }
}

pub struct SessionStoreWrapper(pub Box<dyn SessionStore>);

#[async_trait]
impl SessionStore for SessionStoreWrapper {
    async fn load(&self) -> Result<Option<JsonValue>, MessengerError> {
        self.0.load().await
    }
    async fn save(&self, session: &JsonValue) -> Result<(), MessengerError> {
        self.0.save(session).await
    }
    async fn delete(&self) -> Result<(), MessengerError> {
        self.0.delete().await
    }
}
