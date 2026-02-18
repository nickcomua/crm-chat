//! Re-exports and helpers for the generated Convex typed API.
//!
//! The generated `ConvexApi` trait on `ConvexApiClient` provides typed methods
//! for all Convex functions. This module provides:
//! - Re-exports of commonly used generated types
//! - [`ConvexResult`] trait for unwrapping the inner `ok/error` envelope
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
// ConvexResult — unwrap the ok/error envelope from mutation returns
// ────────────────────────────────────────────────────────────────────────────

/// Trait for converting generated Convex mutation return enums into `Result`.
///
/// Convex mutations that use the `result()` helper return JSON like:
///   `{ ok: true, value: T }` or `{ ok: false, error: "..." }`
///
/// The generated Rust types model this as an untagged enum:
///   `Object(V0 { ok, value })` | `Object2(V1 { ok, error })`
///
/// This trait provides `.into_result()` to collapse both layers into
/// a standard `Result<T, String>`.
pub trait ConvexResult {
    type Value;
    fn into_result(self) -> Result<Self::Value, String>;
}

/// Implement `ConvexResult` for a generated return enum with `value: ()`.
macro_rules! impl_convex_result_unit {
    ($return_ty:ident) => {
        impl ConvexResult for convex_backend::$return_ty {
            type Value = ();
            fn into_result(self) -> Result<(), String> {
                match self {
                    Self::Object(v) if v.ok => Ok(()),
                    Self::Object(_) => {
                        Err("mutation returned ok=false without error details".into())
                    }
                    Self::Object2(v) => Err(v.error),
                }
            }
        }
    };
}

/// Implement `ConvexResult` for a generated return enum with a typed `value`.
macro_rules! impl_convex_result_typed {
    ($return_ty:ident, $value_ty:ty) => {
        impl ConvexResult for convex_backend::$return_ty {
            type Value = $value_ty;
            fn into_result(self) -> Result<$value_ty, String> {
                match self {
                    Self::Object(v) if v.ok => Ok(v.value),
                    Self::Object(_) => {
                        Err("mutation returned ok=false without error details".into())
                    }
                    Self::Object2(v) => Err(v.error),
                }
            }
        }
    };
}

// Phone auth
impl_convex_result_unit!(PhoneAuthWorkerCompleteSendCodeReturn);
impl_convex_result_unit!(PhoneAuthWorkerCompleteVerifyCodeReturn);
impl_convex_result_unit!(PhoneAuthWorkerCompleteVerifyPasswordReturn);

// Worker task updates
impl_convex_result_unit!(WorkerTasksWorkerUpdateTaskReturn);

// Worker tasks
impl_convex_result_unit!(WorkerTasksRunTaskReturn);
impl_convex_result_unit!(WorkerTasksWorkerCompleteReturn);
impl_convex_result_unit!(WorkerTasksCancelTaskReturn);

// WorkerOps — task-validated worker mutations
impl_convex_result_unit!(WorkerOpsUpsertChatReturn);
impl_convex_result_unit!(WorkerOpsUpsertMessageReturn);
impl_convex_result_unit!(WorkerOpsMarkMessageDeletedReturn);
impl_convex_result_unit!(WorkerOpsUpdateSyncProgressReturn);
impl_convex_result_unit!(WorkerOpsUpdateChatPhotoReturn);
impl_convex_result_unit!(WorkerOpsCreatePendingMediaReturn);
impl_convex_result_unit!(WorkerOpsStartMediaDownloadReturn);
impl_convex_result_unit!(WorkerOpsUpdateMediaProgressReturn);
impl_convex_result_unit!(WorkerOpsStoreMediaReturn);
impl_convex_result_unit!(WorkerOpsMarkMediaFailedReturn);

// Clients
impl_convex_result_typed!(ClientsWorkerRegisterConnectedReturn, String);

/// Extension trait on `Result<T, ConvexError>` where `T: ConvexResult`.
///
/// Collapses both the transport-level `ConvexError` and the business-logic
/// `{ ok: false, error }` into a single `Result<T::Value, WorkerError>`.
pub trait ConvexResultExt {
    type Value;
    /// Unwrap both the outer `ConvexError` and inner `ok/error` envelope.
    fn check(self) -> Result<Self::Value, WorkerError>;
    /// Like `check`, but only logs a warning on error instead of propagating.
    fn warn_on_err(self, context: &str) -> Option<Self::Value>;
}

impl<T: ConvexResult> ConvexResultExt for Result<T, convex_backend::ConvexError> {
    type Value = T::Value;

    fn check(self) -> Result<T::Value, WorkerError> {
        self.map_err(|e| WorkerError::MutationFailed(e.to_string()))?
            .into_result()
            .map_err(WorkerError::MutationFailed)
    }

    fn warn_on_err(self, context: &str) -> Option<T::Value> {
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
    client
        .worker_ops_start_media_download(WorkerOpsStartMediaDownloadArgs {
            taskId: task_id.into(),
            telegramFileId: telegram_file_id.into(),
        })
        .await
        .warn_on_err("Failed to transition media to downloading");
}

pub async fn update_download_progress(
    client: &ConvexApiClient,
    task_id: &str,
    telegram_file_id: &str,
    bytes_downloaded: f64,
    file_size: Option<f64>,
) {
    client
        .worker_ops_update_media_progress(WorkerOpsUpdateMediaProgressArgs {
            taskId: task_id.into(),
            telegramFileId: telegram_file_id.into(),
            bytesDownloaded: bytes_downloaded,
            fileSize: file_size,
        })
        .await
        .warn_on_err("Failed to update download progress");
}

pub async fn mark_media_failed(
    client: &ConvexApiClient,
    task_id: &str,
    telegram_file_id: &str,
    error: &str,
) {
    client
        .worker_ops_mark_media_failed(WorkerOpsMarkMediaFailedArgs {
            taskId: task_id.into(),
            telegramFileId: telegram_file_id.into(),
            error: error.into(),
        })
        .await
        .warn_on_err("Failed to mark media as failed");
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
