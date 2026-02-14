//! Telegram operation wrappers and media helpers.

use convex_backend::MessagesUpsertMediaKind;
use messanger_interface::media::MediaKind;

use crate::ops::convex::PendingMediaKind;

/// Convert a `MediaKind` to the generated `MessagesUpsertMediaKind`.
pub fn to_upsert_media_kind(kind: MediaKind) -> MessagesUpsertMediaKind {
    match kind {
        MediaKind::Photo => MessagesUpsertMediaKind::Photo,
        MediaKind::Video => MessagesUpsertMediaKind::Video,
        MediaKind::VideoNote => MessagesUpsertMediaKind::VideoNote,
        MediaKind::Audio => MessagesUpsertMediaKind::Audio,
        MediaKind::Voice => MessagesUpsertMediaKind::Voice,
        MediaKind::Sticker => MessagesUpsertMediaKind::Sticker,
        MediaKind::Animation => MessagesUpsertMediaKind::Animation,
        MediaKind::Document => MessagesUpsertMediaKind::Document,
    }
}

/// Map a `MediaKind` to its default MIME type.
pub fn default_mime_for_kind(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Photo => "image/jpeg",
        MediaKind::Video | MediaKind::VideoNote | MediaKind::Animation => "video/mp4",
        MediaKind::Audio => "audio/mpeg",
        MediaKind::Voice => "audio/ogg",
        MediaKind::Sticker => "image/webp",
        MediaKind::Document => "application/octet-stream",
    }
}

/// Map a pending record's kind (from convex-typegen) to its default MIME type.
pub fn default_mime_for_pending_kind(kind: &PendingMediaKind) -> &'static str {
    match kind {
        PendingMediaKind::Photo => "image/jpeg",
        PendingMediaKind::Video | PendingMediaKind::VideoNote | PendingMediaKind::Animation => {
            "video/mp4"
        }
        PendingMediaKind::Audio => "audio/mpeg",
        PendingMediaKind::Voice => "audio/ogg",
        PendingMediaKind::Sticker => "image/webp",
        PendingMediaKind::Document => "application/octet-stream",
    }
}

/// Parse a media external ID ("media:{chat_id}:{msg_id}") into its components.
pub fn parse_media_external_id(external_id: &str) -> Option<(String, i32)> {
    let parts: Vec<&str> = external_id.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let chat_ext_id = parts[1].to_string();
    let msg_id: i32 = parts[2].parse().ok()?;
    Some((chat_ext_id, msg_id))
}
