//! Telegram operation wrappers and media helpers.

use convex_backend::{
    MediaCreatePendingKind, MessagesUpsertMediaKind,
    WorkerTasksTaskMediaDownloaderDownloadKind as MediaDownloadKind,
};
use messanger_interface::media::MediaKind;

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

/// Convert a `MediaKind` to the generated `MediaCreatePendingKind`.
pub fn to_create_pending_kind(kind: MediaKind) -> MediaCreatePendingKind {
    match kind {
        MediaKind::Photo => MediaCreatePendingKind::Photo,
        MediaKind::Video => MediaCreatePendingKind::Video,
        MediaKind::VideoNote => MediaCreatePendingKind::VideoNote,
        MediaKind::Audio => MediaCreatePendingKind::Audio,
        MediaKind::Voice => MediaCreatePendingKind::Voice,
        MediaKind::Sticker => MediaCreatePendingKind::Sticker,
        MediaKind::Animation => MediaCreatePendingKind::Animation,
        MediaKind::Document => MediaCreatePendingKind::Document,
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

/// Convert a generated `MediaDownloadKind` to its string name (for logging & MIME lookup).
pub fn media_kind_to_str(kind: &MediaDownloadKind) -> &'static str {
    match kind {
        MediaDownloadKind::Photo => "Photo",
        MediaDownloadKind::Video => "Video",
        MediaDownloadKind::VideoNote => "VideoNote",
        MediaDownloadKind::Audio => "Audio",
        MediaDownloadKind::Voice => "Voice",
        MediaDownloadKind::Sticker => "Sticker",
        MediaDownloadKind::Animation => "Animation",
        MediaDownloadKind::Document => "Document",
    }
}

/// Map a media kind string (from the typed workerTask union) to its default MIME type.
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
