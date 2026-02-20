//! Re-exports and helpers for the generated Convex typed API.
//!
//! The generated `ConvexApi` trait on `ConvexApiClient` provides typed methods
//! for all Convex functions. This module provides:
//! - Re-exports of commonly used generated types
//! - [`ConvexResultExt`] for collapsing transport + business-logic errors
//! - The `map_chat_type` helper
//! - Best-effort (fire-and-forget) wrappers for operations where errors are ignored

pub use convex_backend::ConvexApi;
pub use convex_backend::ConvexApiClient;
pub use convex_backend::WorkerOpsUpsertChatChatType;

use convex_backend::{
    ChatsScanEnabledChatIdsArgs, WorkerOpsMarkMediaFailedArgs, WorkerOpsStartMediaDownloadArgs,
    WorkerOpsUpdateMediaProgressArgs, WorkerTasksRunTaskArgs, WorkerTasksTask as Task,
    WorkerTasksWorkerCompleteArgs,
};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::error::WorkerError;

// ────────────────────────────────────────────────────────────────────────────
// ConvexResultExt — collapse transport + business-logic errors
// ────────────────────────────────────────────────────────────────────────────

/// Extension trait on `Result<Result<T, E>, ConvexError>`.
///
/// Convex mutations using the `result()` helper return `{Ok: T}` or `{Err: E}`.
/// convex-typegen maps this to `Result<T, E>` via serde's externally-tagged
/// enum deserialization. The outer `Result` wraps the transport-level `ConvexError`.
///
/// This trait collapses both layers into a single `Result<T, WorkerError>`.
pub trait ConvexResultExt {
    type Value;
    /// Unwrap both the outer `ConvexError` and inner `Result<T, E>`.
    fn check(self) -> Result<Self::Value, WorkerError>;
    /// Like `check`, but only logs a warning on error instead of propagating.
    fn warn_on_err(self, context: &str) -> Option<Self::Value>;
}

impl<T, E: std::fmt::Display> ConvexResultExt
    for Result<Result<T, E>, convex_backend::ConvexError>
{
    type Value = T;

    fn check(self) -> Result<T, WorkerError> {
        self.map_err(|e| WorkerError::MutationFailed(e.to_string()))?
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))
    }

    fn warn_on_err(self, context: &str) -> Option<T> {
        match self.check() {
            Ok(v) => Some(v),
            Err(e) => {
                warn!(error = %e, "{context}");
                None
            }
        }
    }
}

/// Map a Telegram chat type string to a Convex ChatType enum.
pub fn map_chat_type(chat_type: Option<&str>) -> WorkerOpsUpsertChatChatType {
    match chat_type {
        Some("user") => WorkerOpsUpsertChatChatType::Dialog,
        _ => WorkerOpsUpsertChatChatType::Group,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Best-effort wrappers (fire-and-forget, warnings on error)
// ────────────────────────────────────────────────────────────────────────────

pub async fn start_download(client: &ConvexApiClient, task_id: &str, telegram_file_id: &str) {
    if let Err(e) = client
        .worker_ops_start_media_download(WorkerOpsStartMediaDownloadArgs {
            taskId: task_id.into(),
            telegramFileId: telegram_file_id.into(),
        })
        .await
    {
        warn!(error = %e, "Failed to transition media to downloading");
    }
}

pub async fn update_download_progress(
    client: &ConvexApiClient,
    task_id: &str,
    telegram_file_id: &str,
    bytes_downloaded: f64,
    file_size: Option<f64>,
) {
    if let Err(e) = client
        .worker_ops_update_media_progress(WorkerOpsUpdateMediaProgressArgs {
            taskId: task_id.into(),
            telegramFileId: telegram_file_id.into(),
            bytesDownloaded: bytes_downloaded,
            fileSize: file_size,
        })
        .await
    {
        warn!(error = %e, "Failed to update download progress");
    }
}

pub async fn mark_media_failed(
    client: &ConvexApiClient,
    task_id: &str,
    telegram_file_id: &str,
    error: &str,
) {
    if let Err(e) = client
        .worker_ops_mark_media_failed(WorkerOpsMarkMediaFailedArgs {
            taskId: task_id.into(),
            telegramFileId: telegram_file_id.into(),
            error: error.into(),
        })
        .await
    {
        warn!(error = %e, "Failed to mark media as failed");
    }
}

/// Mark a task as Running (Dispatched → Running). Called at handler start.
pub async fn run_task(convex: &ConvexApiClient, task_id: &str) {
    convex
        .worker_tasks_run_task(WorkerTasksRunTaskArgs {
            taskId: task_id.to_string(),
        })
        .await
        .warn_on_err("Failed to mark task running");
}

/// Best-effort task completion: runs type-specific logic then deletes the task.
/// Pass `None` for tasks with no completion data; pass `Some(task)` for types
/// that carry final state (e.g. QrAuth with telegramUserId).
pub async fn worker_complete(convex: &ConvexApiClient, task_id: &str) {
    convex
        .worker_tasks_worker_complete(WorkerTasksWorkerCompleteArgs {
            taskId: task_id.to_string(),
            task: None,
        })
        .await
        .warn_on_err("Failed to complete task");
}

// ────────────────────────────────────────────────────────────────────────────
// Shared payload type
// ────────────────────────────────────────────────────────────────────────────

/// Wrapper around a Task variant with `task_id` injected by the orchestrator.
/// All Restate handlers deserialize this instead of raw `Task`.
#[derive(Serialize, Deserialize)]
pub struct TaskPayload {
    pub task_id: String,
    #[serde(flatten)]
    pub task: Task,
}

// ────────────────────────────────────────────────────────────────────────────
// Shared query helpers
// ────────────────────────────────────────────────────────────────────────────

/// Query scan-enabled chatIds for a client. Returns composite chatIds (e.g. "clientId:extId").
pub async fn scan_enabled_chat_ids(
    convex: &ConvexApiClient,
    client_id: &str,
) -> Result<Vec<String>, WorkerError> {
    convex
        .query_chats_scan_enabled_chat_ids(ChatsScanEnabledChatIdsArgs {
            clientId: client_id.to_string(),
        })
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))
}
