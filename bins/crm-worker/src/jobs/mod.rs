//! Concrete `Job` implementations.
//!
//! Each job corresponds to a single kind of entity-state transition in Convex.
//! Per-table `pendingWork` queries on the Convex side (`clients.pendingWork`,
//! `chats.pendingWork`, `media.pendingWork`, `phoneAuth.pendingWork`,
//! `qrAuth.pendingWork`) already return the exact set of entities that need
//! work, each tagged with a `service` name — these jobs filter that set by
//! service name and project to the entity IDs.

pub mod chat_scanner;
pub mod dialog_sync;
pub mod media_downloader;
pub mod phone_auth;
pub mod qr_auth;
pub mod send_messages;
pub mod update_listener;
