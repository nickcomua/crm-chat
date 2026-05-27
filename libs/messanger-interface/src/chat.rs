//! Chat-related types and structures.

use serde::{Deserialize, Serialize};

use crate::types::ExternalId;

/// Universal chat summary with minimal required information.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatSummary {
    /// Platform-specific external identifier for this chat.
    pub external_id: ExternalId,
    /// Display name of the chat (if available).
    pub name: Option<String>,
    /// Type/category of the chat (e.g., "user", "group", "channel").
    pub chat_type: Option<String>,
    /// Whether this chat is pinned in the messenger platform.
    pub is_pinned: bool,
    /// Profile-photo identifier from the platform (e.g. Telegram photo_id).
    pub photo_id: Option<String>,
}
