//! Media-related types and structures.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::types::ExternalId;

/// Universal media kind enumeration.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MediaKind {
    Photo,
    Video,
    VideoNote,
    Audio,
    Voice,
    Sticker,
    Animation,
    Document,
}

impl MediaKind {
    /// Returns the Convex-compatible string representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Photo => "Photo",
            Self::Video => "Video",
            Self::VideoNote => "VideoNote",
            Self::Audio => "Audio",
            Self::Voice => "Voice",
            Self::Sticker => "Sticker",
            Self::Animation => "Animation",
            Self::Document => "Document",
        }
    }
}

/// Universal media summary with minimal required information.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaSummary {
    /// Platform-specific external identifier for this media.
    pub external_id: ExternalId,
    /// Type/category of the media.
    pub kind: MediaKind,
    /// URL or file path to access the media (if available).
    pub url: Option<String>,
    /// Additional metadata about the media (e.g., file size, dimensions).
    pub metadata: Option<JsonValue>,
    /// MIME type of the media file.
    pub mime_type: Option<String>,
    /// Original file name.
    pub file_name: Option<String>,
    /// File size in bytes.
    pub file_size: Option<usize>,
    /// Width in pixels (for images/videos).
    pub width: Option<i32>,
    /// Height in pixels (for images/videos).
    pub height: Option<i32>,
    /// Duration in seconds (for audio/video).
    pub duration: Option<f64>,
}
