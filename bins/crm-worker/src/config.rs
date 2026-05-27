//! Configuration for crm-worker service.

use anyhow::Result;
use std::path::PathBuf;

/// Telegram API credentials and worker configuration.
#[derive(Clone)]
pub struct WorkerConfig {
    pub api_id: i32,
    pub api_hash: String,
    pub convex_url: String,
    pub m2m_secret_key: String,
}

impl WorkerConfig {
    /// Load configuration from process environment variables.
    pub fn from_env() -> Result<Self> {
        let api_id: i32 = std::env::var("TG_ID")
            .expect("TG_ID is required")
            .parse()
            .expect("TG_ID must be a valid integer");
        let api_hash = std::env::var("TG_HASH").expect("TG_HASH is required");
        let convex_url = std::env::var("CONVEX_URL").expect("CONVEX_URL is required");
        let m2m_secret_key =
            std::env::var("CLERK_M2M_SECRET_KEY").expect("CLERK_M2M_SECRET_KEY is required");

        Ok(Self {
            api_id,
            api_hash,
            convex_url,
            m2m_secret_key,
        })
    }
}

/// Get the directory where session files are stored.
///
/// When `TG_SESSION_DIR` is set, uses that path directly.
/// Otherwise uses the platform data directory (`~/Library/Application Support` on macOS).
pub fn get_session_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TG_SESSION_DIR") {
        let path = PathBuf::from(dir);
        std::fs::create_dir_all(&path).ok();
        return path;
    }
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("crm-chat")
        .join("telegram-sessions");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir
}

/// Sanitize an owner ID (Clerk userId) for use as a directory name.
pub fn sanitize_owner_id(owner_id: &str) -> String {
    owner_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
