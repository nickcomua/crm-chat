//! Telegram operation wrappers and media helpers.

use convex_backend::{MediaWorkerCreatePendingMediaKind, MessagesWorkerUpsertMessageMediaKind};
use messanger_interface::media::MediaKind;

/// Convert a `MediaKind` to the generated `MessagesWorkerUpsertMessageMediaKind`.
pub fn to_upsert_media_kind(kind: MediaKind) -> MessagesWorkerUpsertMessageMediaKind {
    match kind {
        MediaKind::Photo => MessagesWorkerUpsertMessageMediaKind::Photo,
        MediaKind::Video => MessagesWorkerUpsertMessageMediaKind::Video,
        MediaKind::VideoNote => MessagesWorkerUpsertMessageMediaKind::VideoNote,
        MediaKind::Audio => MessagesWorkerUpsertMessageMediaKind::Audio,
        MediaKind::Voice => MessagesWorkerUpsertMessageMediaKind::Voice,
        MediaKind::Sticker => MessagesWorkerUpsertMessageMediaKind::Sticker,
        MediaKind::Animation => MessagesWorkerUpsertMessageMediaKind::Animation,
        MediaKind::Document => MessagesWorkerUpsertMessageMediaKind::Document,
    }
}

/// Convert a `MediaKind` to the generated `MediaWorkerCreatePendingMediaKind`.
pub fn to_create_pending_kind(kind: MediaKind) -> MediaWorkerCreatePendingMediaKind {
    match kind {
        MediaKind::Photo => MediaWorkerCreatePendingMediaKind::Photo,
        MediaKind::Video => MediaWorkerCreatePendingMediaKind::Video,
        MediaKind::VideoNote => MediaWorkerCreatePendingMediaKind::VideoNote,
        MediaKind::Audio => MediaWorkerCreatePendingMediaKind::Audio,
        MediaKind::Voice => MediaWorkerCreatePendingMediaKind::Voice,
        MediaKind::Sticker => MediaWorkerCreatePendingMediaKind::Sticker,
        MediaKind::Animation => MediaWorkerCreatePendingMediaKind::Animation,
        MediaKind::Document => MediaWorkerCreatePendingMediaKind::Document,
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
    if parts.len() < 3 || parts[0] != "media" {
        return None;
    }
    let chat_ext_id = parts[1].to_string();
    let msg_id: i32 = parts[2].parse().ok()?;
    Some((chat_ext_id, msg_id))
}

/// Parse a profile-photo external ID ("profile:{chat_id}:{photo_id}") into its components.
pub fn parse_profile_photo_external_id(external_id: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = external_id.split(':').collect();
    if parts.len() < 3 || parts[0] != "profile" {
        return None;
    }
    let chat_ext_id = parts[1].to_string();
    let photo_id = parts[2].to_string();
    Some((chat_ext_id, photo_id))
}
