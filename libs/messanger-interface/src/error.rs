//! Error types for messenger client operations.

use thiserror::Error;

/// Error type for messenger client operations.
#[derive(Error, Debug, Clone)]
pub enum MessengerError {
    #[error("Authentication failed: {0}")]
    Authentication(String),
    #[error("Connection error: {0}")]
    Connection(String),
    #[error("Session error: {0}")]
    Session(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Serialization error: {0}")]
    Serialization(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Other error: {0}")]
    Other(String),
}
