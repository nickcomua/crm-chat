//! Telegram operation wrappers and media helpers.

use convex_backend::{
    WorkerOpsCreatePendingMediaKind, WorkerOpsUpsertMessageMediaKind,
    WorkerTasksTaskMediaDownloaderKind as MediaDownloadKind,
};
use messanger_interface::media::MediaKind;

/// Convert a `MediaKind` to the generated `WorkerOpsUpsertMessageMediaKind`.
pub fn to_upsert_media_kind(kind: MediaKind) -> WorkerOpsUpsertMessageMediaKind {
    match kind {
        MediaKind::Photo => WorkerOpsUpsertMessageMediaKind::Photo,
        MediaKind::Video => WorkerOpsUpsertMessageMediaKind::Video,
        MediaKind::VideoNote => WorkerOpsUpsertMessageMediaKind::VideoNote,
        MediaKind::Audio => WorkerOpsUpsertMessageMediaKind::Audio,
        MediaKind::Voice => WorkerOpsUpsertMessageMediaKind::Voice,
        MediaKind::Sticker => WorkerOpsUpsertMessageMediaKind::Sticker,
        MediaKind::Animation => WorkerOpsUpsertMessageMediaKind::Animation,
        MediaKind::Document => WorkerOpsUpsertMessageMediaKind::Document,
    }
}

/// Convert a `MediaKind` to the generated `WorkerOpsCreatePendingMediaKind`.
pub fn to_create_pending_kind(kind: MediaKind) -> WorkerOpsCreatePendingMediaKind {
    match kind {
        MediaKind::Photo => WorkerOpsCreatePendingMediaKind::Photo,
        MediaKind::Video => WorkerOpsCreatePendingMediaKind::Video,
        MediaKind::VideoNote => WorkerOpsCreatePendingMediaKind::VideoNote,
        MediaKind::Audio => WorkerOpsCreatePendingMediaKind::Audio,
        MediaKind::Voice => WorkerOpsCreatePendingMediaKind::Voice,
        MediaKind::Sticker => WorkerOpsCreatePendingMediaKind::Sticker,
        MediaKind::Animation => WorkerOpsCreatePendingMediaKind::Animation,
        MediaKind::Document => WorkerOpsCreatePendingMediaKind::Document,
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
