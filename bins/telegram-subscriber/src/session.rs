//! Session management for Telegram authentication.

use grammers_client::Client;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub type LoginToken = grammers_client::client::LoginToken;
pub type PasswordToken = grammers_client::client::PasswordToken;

/// Holds an active Telegram login session during authentication flow.
pub struct LoginSession {
    /// The Telegram client instance.
    pub client: Client,
    /// Login token received after requesting code (used for sign_in).
    pub token: Option<LoginToken>,
    /// Password token received when 2FA is required.
    pub password_token: Option<PasswordToken>,
    /// Path to the SQLite session file.
    #[allow(dead_code)]
    pub session_path: PathBuf,
}

impl LoginSession {
    /// Create a new login session.
    pub fn new(client: Client, token: LoginToken, session_path: PathBuf) -> Self {
        Self {
            client,
            token: Some(token),
            password_token: None,
            session_path,
        }
    }
}

/// Thread-safe map of client IDs to their active login sessions.
pub type ActiveSessions = Arc<Mutex<HashMap<u64, LoginSession>>>;

/// Create a new empty active sessions map.
pub fn new_active_sessions() -> ActiveSessions {
    Arc::new(Mutex::new(HashMap::new()))
}
