//! Message-related types and structures.

use serde::{Deserialize, Serialize};

use crate::types::ExternalId;

/// Universal message summary with minimal required information.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageSummary {
    /// Platform-specific external identifier for this message.
    pub external_id: ExternalId,
    /// External identifier of the chat this message belongs to.
    pub chat_external_id: ExternalId,
    /// External identifier of the sender of this message.
    pub sender_id: ExternalId,
    /// Text content of the message (if available).
    pub text: Option<String>,
    /// Whether this message was sent by the authenticated user.
    pub outgoing: bool,
    /// Timestamp in milliseconds since epoch (if available).
    pub timestamp_ms: Option<u64>,
    /// External identifier of associated media (if any).
    pub media_external_id: Option<ExternalId>,
}
