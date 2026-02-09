//! Error types for task execution.

use thiserror::Error;

/// Errors that can occur during task execution.
#[derive(Error, Debug)]
pub enum TaskError {
    /// Failed to build Telegram client.
    #[error("failed to build Telegram client: {0}")]
    ClientBuildFailed(String),

    /// Failed to serialize/deserialize data.
    #[error("serialization error: {0}")]
    Serialization(String),

    /// Failed to call SpacetimeDB reducer.
    #[error("SpacetimeDB reducer error: {0}")]
    ReducerFailed(String),

    /// Password token deserialization failed.
    #[error("failed to deserialize password token: {0}")]
    PasswordTokenInvalid(String),
}

impl From<serde_json::Error> for TaskError {
    fn from(err: serde_json::Error) -> Self {
        TaskError::Serialization(err.to_string())
    }
}
