//! Restate service definitions and reconciler.
//!
//! - `reconciler`: Plain async loop (NOT a Restate service) — subscribes
//!   to the `orchestrator.pendingWork` query and dispatches to leaf services
//!   via HTTP ingress
//! - `DialogSync`: Syncs Telegram dialog list to Convex
//! - `ProfilePhotoSync`: Downloads and uploads chat profile photos
//! - `ChatScanner`: Per-chat message scanning
//! - `MediaDownloader`: Per-file media download
//! - `UpdateListener`: Real-time Telegram update stream
//! - `PhoneAuthWorkflow`: Durable workflow for phone-based authentication
//! - `QrAuthWorkflow`: Durable workflow for QR-code-based authentication

pub mod chat_scanner;
pub mod dialog_sync;
pub mod media_downloader;
pub mod phone_auth;
pub mod profile_photo_sync;
pub mod qr_auth;
pub mod reconciler;
pub mod update_listener;
