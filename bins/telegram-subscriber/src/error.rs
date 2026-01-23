//! Error types for task execution.

use thiserror::Error;

/// Errors that can occur during task execution.
#[derive(Error, Debug)]
pub enum TaskError {
    /// Task is not a robot task and should not be processed by the robot.
    #[error("task is not a robot task")]
    NotRobotTask,

    /// Task is not assigned to this robot.
    #[error("task is not assigned to this robot")]
    NotAssignedToMe,

    /// Failed to build Telegram client.
    #[error("failed to build Telegram client: {0}")]
    ClientBuildFailed(String),

    /// Failed to serialize/deserialize data.
    #[error("serialization error: {0}")]
    Serialization(String),

    /// Failed to call SpacetimeDB reducer.
    #[error("SpacetimeDB reducer error: {0}")]
    ReducerFailed(String),

    /// Login token not found (needed for VerifyLoginCode).
    #[error("login token not found for phone: {0}")]
    LoginTokenNotFound(String),

    /// Password token deserialization failed.
    #[error("failed to deserialize password token: {0}")]
    PasswordTokenInvalid(String),
}

impl From<serde_json::Error> for TaskError {
    fn from(err: serde_json::Error) -> Self {
        TaskError::Serialization(err.to_string())
    }
}
