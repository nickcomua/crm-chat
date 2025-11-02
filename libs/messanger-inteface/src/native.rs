//! Native payload wrapper for platform-specific data.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Native payload wrapper for platform-specific data.
///
/// This allows clients to access the raw, platform-specific representation
/// of chats, messages, media, or other entities as serialized JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativePayload {
    /// The native payload as JSON.
    pub payload: JsonValue,
}
