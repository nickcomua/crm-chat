//! Re-exports and helpers for the generated Convex typed API.
//!
//! The generated `ConvexApi` trait on `ConvexApiClient` provides typed methods
//! for all Convex functions. This module provides:
//! - Re-exports of commonly used generated types
//! - The `map_chat_type` helper
//! - Best-effort (fire-and-forget) wrappers for operations where errors are ignored

pub use convex_backend::ChatsUpsertChatType;
pub use convex_backend::ConvexApi;
pub use convex_backend::ConvexApiClient;

use convex_backend::{
    ChatsListForWorkerArgs, ChatsTable, MediaMarkFailedArgs, MediaStartDownloadArgs,
    MediaUpdateProgressArgs,
};

use crate::error::WorkerError;

/// Map a Telegram chat type string to a Convex ChatType enum.
pub fn map_chat_type(chat_type: Option<&str>) -> ChatsUpsertChatType {
    match chat_type {
        Some("user") => ChatsUpsertChatType::Dialog,
        _ => ChatsUpsertChatType::Group,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Best-effort wrappers (fire-and-forget, errors intentionally ignored)
// ────────────────────────────────────────────────────────────────────────────

pub async fn start_download(client: &ConvexApiClient, telegram_file_id: &str) {
    let _ = client
        .media_start_download(MediaStartDownloadArgs {
            telegramFileId: telegram_file_id.into(),
        })
        .await;
}

pub async fn update_download_progress(
    client: &ConvexApiClient,
    telegram_file_id: &str,
    bytes_downloaded: f64,
    file_size: Option<f64>,
) {
    let _ = client
        .media_update_progress(MediaUpdateProgressArgs {
            telegramFileId: telegram_file_id.into(),
            bytesDownloaded: bytes_downloaded,
            fileSize: file_size,
        })
        .await;
}

pub async fn mark_media_failed(client: &ConvexApiClient, telegram_file_id: &str, error: &str) {
    let _ = client
        .media_mark_failed(MediaMarkFailedArgs {
            telegramFileId: telegram_file_id.into(),
            error: error.into(),
        })
        .await;
}

// ────────────────────────────────────────────────────────────────────────────
// Shared query helpers
// ────────────────────────────────────────────────────────────────────────────

/// Query the list of chats for a worker's client.
pub async fn list_worker_chats(
    convex: &ConvexApiClient,
    client_id: &str,
) -> Result<Vec<ChatsTable>, WorkerError> {
    convex
        .query_chats_list_for_worker(ChatsListForWorkerArgs {
            clientId: client_id.to_string(),
        })
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))
}

