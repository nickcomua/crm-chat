//! Restate service definitions and orchestrator.
//!
//! - `task_orchestrator`: Plain async loop (NOT a Restate service) — subscribes
//!   to Convex queries and dispatches to leaf services via HTTP ingress
//! - `DialogSync`:       Syncs Telegram dialog list to Convex
//! - `ProfilePhotoSync`: Downloads and uploads chat profile photos
//! - `ChatScanner`:      Per-chat message scanning
//! - `MediaDownloader`:  Batch download of pending media files
//! - `UpdateListener`:   Real-time Telegram update stream
//! - `PhoneAuthWorkflow`: Durable workflow for phone-based authentication
//! - `QrAuthWorkflow`:    Durable workflow for QR-code-based authentication

pub mod chat_scanner;
pub mod dialog_sync;
pub mod media_downloader;
pub mod phone_auth;
pub mod profile_photo_sync;
pub mod qr_auth;
pub mod task_orchestrator;
pub mod update_listener;

// All handler inputs use generated Convex table types directly — no custom
// request structs. The orchestrator sends the same types it receives from
// Convex subscriptions, eliminating mapping boilerplate.
