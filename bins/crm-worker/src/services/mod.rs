//! Restate service definitions.
//!
//! - `ClientScanner`:    Orchestrator — dispatches scan work to sub-services
//! - `DialogSync`:       Syncs Telegram dialog list to Convex
//! - `ProfilePhotoSync`: Downloads and uploads chat profile photos
//! - `ChatScanner`:      Per-chat message scanning
//! - `MediaDownloader`:  Batch download of pending media files
//! - `UpdateListener`:   Real-time Telegram update stream
//! - `PhoneAuthWorkflow`: Durable workflow for phone-based authentication
//! - `QrAuthWorkflow`:    Durable workflow for QR-code-based authentication

pub mod chat_scanner;
pub mod client_scanner;
pub mod dialog_sync;
pub mod media_downloader;
pub mod phone_auth;
pub mod profile_photo_sync;
pub mod qr_auth;
pub mod update_listener;

use serde::{Deserialize, Serialize};

/// Shared request type for scan-related services.
#[derive(Serialize, Deserialize, Clone)]
pub struct ScanRequest {
    pub client_id: String,
    pub user_id: String,
    pub external_id: String,
}
