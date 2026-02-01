//! SpacetimeDB module for CRM Chat.

pub mod chat;
pub mod client;
pub mod message;
pub mod robot;
pub mod task;
pub mod user;
pub mod validation;

// Re-export all public items for convenience
pub use chat::*;
pub use client::*;
pub use message::*;
pub use robot::*;
pub use task::*;
pub use user::*;
