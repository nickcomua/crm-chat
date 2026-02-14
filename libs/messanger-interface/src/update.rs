//! Update event types from messenger platforms.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::message::MessageSummary;
use crate::types::ExternalId;

/// Universal update event from the messenger platform.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Update {
    /// A new message was received.
    NewMessage(MessageSummary),
    /// A message was edited.
    MessageEdited(MessageSummary),
    /// A message was deleted.
    MessageDeleted {
        /// External identifier of the deleted message.
        message_external_ids: Vec<ExternalId>,
        /// External identifier of the chat.
        chat_external_id: Option<ExternalId>,
    },
    /// Other update types (platform-specific).
    Other {
        /// Update type identifier.
        update_type: String,
        /// Update payload as JSON.
        payload: JsonValue,
    },
}
