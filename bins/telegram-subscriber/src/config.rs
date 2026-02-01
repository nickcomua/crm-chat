//! Configuration for Telegram subscriber service.

use anyhow::Result;
use std::env;
use std::path::PathBuf;

/// Telegram API credentials
#[derive(Clone)]
pub struct TelegramConfig {
    pub api_id: i32,
    pub api_hash: String,
}

impl TelegramConfig {
    /// Load Telegram API credentials from environment variables.
    pub fn from_env() -> Result<Self> {
        let api_id: i32 = env::var("TG_ID")
            .expect("TG_ID environment variable not set")
            .parse()
            .expect("TG_ID must be a valid integer");
        let api_hash = env::var("TG_HASH").expect("TG_HASH environment variable not set");
        Ok(Self { api_id, api_hash })
    }
}

/// Get the directory where session files are stored.
pub fn get_session_dir() -> PathBuf {
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("crm-chat")
        .join("telegram-sessions");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir
}

/// Get the session file path for a given phone number.
pub fn get_session_path(phone: &str, owner_id: &str) -> PathBuf {
    // Sanitize phone number for use in filename
    let sanitized: String = phone
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();
    let dir = get_session_dir().join(owner_id);
    std::fs::create_dir_all(&dir).ok();
    dir.join(format!("{}.session", sanitized))
}
