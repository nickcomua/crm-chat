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
///
/// Also writes an `.owner` file with the original `owner_id` so
/// session discovery can recover it from the sanitized directory name.
pub fn get_session_path(identifier: &str, owner_id: &str) -> PathBuf {
    let sanitized: String = identifier
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();

    let dir = get_session_dir().join(sanitize_owner_id(owner_id));
    std::fs::create_dir_all(&dir).ok();

    // Persist the original owner_id for session discovery
    let owner_file = dir.join(".owner");
    if !owner_file.exists() {
        std::fs::write(&owner_file, owner_id).ok();
    }

    dir.join(format!("{sanitized}.session"))
}

/// Discover all session files on disk.
///
/// Returns `(owner_id, session_path)` pairs for each `.session` file found.
/// The `owner_id` is recovered from the `.owner` file written by [`get_session_path`].
pub fn discover_session_files() -> Vec<(String, PathBuf)> {
    let session_dir = get_session_dir();
    let mut results = Vec::new();

    let entries = match std::fs::read_dir(&session_dir) {
        Ok(entries) => entries,
        Err(_) => return results,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // Read the .owner file to recover the original userId
        let owner_file = path.join(".owner");
        let owner_id = match std::fs::read_to_string(&owner_file) {
            Ok(id) => id.trim().to_string(),
            Err(_) => continue, // skip directories without .owner
        };

        // Find all .session files in this owner directory
        let session_entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for session_entry in session_entries.flatten() {
            let session_path = session_entry.path();
            if session_path.extension().is_some_and(|ext| ext == "session") {
                results.push((owner_id.clone(), session_path));
            }
        }
    }

    results
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
