//! Re-exports and helpers for the generated Convex typed API.
//!
//! The generated `ConvexApi` trait on `ConvexApiClient` provides typed methods
//! for all Convex functions. This module provides:
//! - Re-exports of commonly used generated types
//! - [`ConvexResult`] trait for unwrapping the inner `ok/error` envelope
//! - The `map_chat_type` helper
//! - Best-effort (fire-and-forget) wrappers for operations where errors are ignored

pub use convex_backend::ChatsUpsertChatType;
pub use convex_backend::ConvexApi;
pub use convex_backend::ConvexApiClient;

use convex_backend::{
    ChatsListForWorkerArgs, ChatsTable, MediaMarkFailedArgs, MediaStartDownloadArgs,
    MediaUpdateProgressArgs,
};
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
impl_convex_result_unit!(PhoneAuthWorkerClaimReturn);
impl_convex_result_unit!(PhoneAuthWorkerCompleteSendCodeReturn);
impl_convex_result_unit!(PhoneAuthWorkerCompleteVerifyCodeReturn);
impl_convex_result_unit!(PhoneAuthWorkerCompleteVerifyPasswordReturn);

// QR auth
impl_convex_result_unit!(QrAuthWorkerClaimReturn);
impl_convex_result_unit!(QrAuthWorkerCompleteQrAuthReturn);
impl_convex_result_unit!(QrAuthWorkerUpdateQrTokenReturn);

// Chats
impl_convex_result_unit!(ChatsUpsertReturn);
impl_convex_result_unit!(ChatsMarkFullScannedReturn);
impl_convex_result_unit!(ChatsUpdateSyncProgressReturn);
impl_convex_result_unit!(ChatsUpdatePhotoReturn);

// Messages
impl_convex_result_unit!(MessagesUpsertReturn);
impl_convex_result_unit!(MessagesMarkDeletedReturn);

// Media
impl_convex_result_unit!(MediaCreatePendingReturn);
impl_convex_result_unit!(MediaStartDownloadReturn);
impl_convex_result_unit!(MediaUpdateProgressReturn);
impl_convex_result_unit!(MediaMarkFailedReturn);
impl_convex_result_unit!(MediaStoreMediaReturn);

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
pub fn map_chat_type(chat_type: Option<&str>) -> ChatsUpsertChatType {
    match chat_type {
        Some("user") => ChatsUpsertChatType::Dialog,
        _ => ChatsUpsertChatType::Group,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Best-effort wrappers (fire-and-forget, warnings on error)
// ────────────────────────────────────────────────────────────────────────────

pub async fn start_download(client: &ConvexApiClient, telegram_file_id: &str) {
    client
        .media_start_download(MediaStartDownloadArgs {
            telegramFileId: telegram_file_id.into(),
        })
        .await
        .warn_on_err("Failed to transition media to downloading");
}

pub async fn update_download_progress(
    client: &ConvexApiClient,
    telegram_file_id: &str,
    bytes_downloaded: f64,
    file_size: Option<f64>,
) {
    client
        .media_update_progress(MediaUpdateProgressArgs {
            telegramFileId: telegram_file_id.into(),
            bytesDownloaded: bytes_downloaded,
            fileSize: file_size,
        })
        .await
        .warn_on_err("Failed to update download progress");
}

pub async fn mark_media_failed(client: &ConvexApiClient, telegram_file_id: &str, error: &str) {
    client
        .media_mark_failed(MediaMarkFailedArgs {
            telegramFileId: telegram_file_id.into(),
            error: error.into(),
        })
        .await
        .warn_on_err("Failed to mark media as failed");
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
