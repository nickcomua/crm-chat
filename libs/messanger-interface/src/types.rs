//! Core type aliases and configuration types.

use serde_json::Value as JsonValue;
use std::pin::Pin;
use tokio_stream::Stream;

use crate::chat::ChatSummary;
use crate::error::MessengerError;
use crate::message::MessageSummary;
use crate::update::Update;

/// External identifier for a chat, message, or media (platform-specific string).
pub type ExternalId = String;

/// Authentication configuration for messenger clients.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// Platform-specific authentication credentials/config.
    pub credentials: JsonValue,
}

/// Type alias for a stream of dialogs/chats.
pub type DialogStream = Pin<Box<dyn Stream<Item = Result<ChatSummary, MessengerError>> + Send>>;

/// Type alias for a stream of messages.
pub type MessageStream = Pin<Box<dyn Stream<Item = Result<MessageSummary, MessengerError>> + Send>>;

/// Type alias for a stream of updates.
pub type UpdateStream = Pin<Box<dyn Stream<Item = Result<Update, MessengerError>> + Send>>;
