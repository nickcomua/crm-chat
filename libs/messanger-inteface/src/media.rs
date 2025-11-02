//! Media-related types and structures.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::types::ExternalId;

/// Universal media kind enumeration.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MediaKind {
    Photo,
    Video,
    Audio,
    MessageRef,
}

/// Universal media summary with minimal required information.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaSummary {
    /// Platform-specific external identifier for this media.
    pub external_id: ExternalId,
    /// Type/category of the media.
    pub kind: MediaKind,
    /// URL or file path to access the media (if available).
    pub url: Option<String>,
    /// Additional metadata about the media (e.g., file size, dimensions).
    pub metadata: Option<JsonValue>,
}
