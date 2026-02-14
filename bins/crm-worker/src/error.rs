//! Error types for crm-worker.

use thiserror::Error;

/// Errors that can occur during task execution.
#[derive(Error, Debug)]
pub enum WorkerError {
    /// Failed to build Telegram client.
    #[error("failed to build Telegram client: {0}")]
    ClientBuildFailed(String),

    /// Failed to serialize/deserialize data.
    #[error("serialization error: {0}")]
    Serialization(String),

    /// Failed to call Convex mutation.
    #[error("Convex mutation error: {0}")]
    MutationFailed(String),

    /// Session not found on disk.
    #[error("session not found: {0}")]
    SessionNotFound(String),
}

impl From<serde_json::Error> for WorkerError {
    fn from(err: serde_json::Error) -> Self {
        WorkerError::Serialization(err.to_string())
    }
}

impl From<convex_backend::ConvexError> for WorkerError {
    fn from(err: convex_backend::ConvexError) -> Self {
        WorkerError::MutationFailed(err.to_string())
    }
}

