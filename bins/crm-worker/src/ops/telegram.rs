//! Telegram operation wrappers and media helpers.

use convex_backend::{DomainOpsCreatePendingMediaKind, DomainOpsUpsertMessageMediaKind};
use messanger_interface::media::MediaKind;

/// Convert a `MediaKind` to the generated `DomainOpsUpsertMessageMediaKind`.
pub fn to_upsert_media_kind(kind: MediaKind) -> DomainOpsUpsertMessageMediaKind {
    match kind {
        MediaKind::Photo => DomainOpsUpsertMessageMediaKind::Photo,
        MediaKind::Video => DomainOpsUpsertMessageMediaKind::Video,
        MediaKind::VideoNote => DomainOpsUpsertMessageMediaKind::VideoNote,
        MediaKind::Audio => DomainOpsUpsertMessageMediaKind::Audio,
        MediaKind::Voice => DomainOpsUpsertMessageMediaKind::Voice,
        MediaKind::Sticker => DomainOpsUpsertMessageMediaKind::Sticker,
        MediaKind::Animation => DomainOpsUpsertMessageMediaKind::Animation,
        MediaKind::Document => DomainOpsUpsertMessageMediaKind::Document,
    }
}

/// Convert a `MediaKind` to the generated `DomainOpsCreatePendingMediaKind`.
pub fn to_create_pending_kind(kind: MediaKind) -> DomainOpsCreatePendingMediaKind {
    match kind {
        MediaKind::Photo => DomainOpsCreatePendingMediaKind::Photo,
        MediaKind::Video => DomainOpsCreatePendingMediaKind::Video,
        MediaKind::VideoNote => DomainOpsCreatePendingMediaKind::VideoNote,
        MediaKind::Audio => DomainOpsCreatePendingMediaKind::Audio,
        MediaKind::Voice => DomainOpsCreatePendingMediaKind::Voice,
        MediaKind::Sticker => DomainOpsCreatePendingMediaKind::Sticker,
        MediaKind::Animation => DomainOpsCreatePendingMediaKind::Animation,
        MediaKind::Document => DomainOpsCreatePendingMediaKind::Document,
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

/// Map a media kind string to its default MIME type.
pub fn default_mime_for_kind_str(kind: &str) -> &'static str {
    match kind {
        "Photo" => "image/jpeg",
        "Video" | "VideoNote" | "Animation" => "video/mp4",
        "Audio" => "audio/mpeg",
        "Voice" => "audio/ogg",
        "Sticker" => "image/webp",
        _ => "application/octet-stream",
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
