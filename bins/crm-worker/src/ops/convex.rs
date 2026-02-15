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
pub use convex_backend::MediaListPendingForClientReturnKind as PendingMediaKind;

use convex_backend::{
    ChatsListForWorkerArgs, ChatsTable, ChatsUpdateSyncProgressArgs,
    ChatsUpdateSyncProgressScanPhase, MediaMarkFailedArgs, MediaStartDownloadArgs,
    MediaUpdateProgressArgs,
};
use tracing::warn;

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

/// Update the scan phase for all scan-enabled chats of a client.
pub async fn set_scan_phase_for_client(
    convex: &ConvexApiClient,
    client_id: &str,
    phase: ChatsUpdateSyncProgressScanPhase,
) {
    let chats = match list_worker_chats(convex, client_id).await {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "Failed to query chats for phase update");
            return;
        }
    };

    for chat in chats.iter().filter(|c| c.scan_enabled.unwrap_or(false)) {
        convex
            .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                chatId: chat.chat_id.clone(),
                totalMessages: None,
                syncedMessages: None,
                scanPhase: Some(phase),
            })
            .await
            .ok();
    }
}
