//! SpacetimeDB module for CRM Chat.

pub mod chat;
pub mod client;
pub mod message;
pub mod notification;
pub mod phone_auth;
pub mod qr_auth;
pub mod robot;
pub mod user;
pub mod validation;

// Re-export all public items for convenience
pub use chat::*;
pub use client::*;
pub use message::*;
pub use notification::*;
pub use phone_auth::*;
pub use qr_auth::*;
pub use robot::*;
pub use user::*;
