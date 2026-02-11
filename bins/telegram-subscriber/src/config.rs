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
///
/// When `TG_SESSION_DIR` is set, uses that path directly.
/// Otherwise uses the platform data directory (`~/Library/Application Support` on macOS).
pub fn get_session_dir() -> PathBuf {
    if let Ok(dir) = env::var("TG_SESSION_DIR") {
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
///
/// Replaces non-alphanumeric characters (except `-` and `_`) with `_`.
/// E.g. `https://example.clerk.dev|user_abc123` → `https___example_clerk_dev_user_abc123`
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

/// Get the session file path for a given identifier and owner.
///
/// The identifier is sanitized to keep only digits and `+`:
/// - Phone auth: `"+1234567890"` → `"+1234567890"`
/// - QR/external ID: `"telegram:123456789"` → `"123456789"`
pub fn get_session_path(identifier: &str, owner_id: &str) -> PathBuf {
    let sanitized: String = identifier
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();

    let dir = get_session_dir().join(sanitize_owner_id(owner_id));
    std::fs::create_dir_all(&dir).ok();
    dir.join(format!("{sanitized}.session"))
}

/// Copy the QR auth session file to the scanner-expected path.
///
/// For QR auth, the session file is created under the auth document ID.
/// The scanner looks for it under the Telegram external ID (`telegram:{user_id}`).
/// This copies the file so the scanner can find it.
pub fn copy_session_for_scanning(auth_identifier: &str, owner_id: &str, telegram_user_id: i64) {
    let auth_path = get_session_path(auth_identifier, owner_id);
    let scan_path = get_session_path(&format!("telegram:{telegram_user_id}"), owner_id);
    if auth_path != scan_path && auth_path.exists() {
        std::fs::copy(&auth_path, &scan_path).ok();
    }
}
