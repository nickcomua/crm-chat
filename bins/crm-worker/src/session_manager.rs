//! Unified session management: path construction, client caching, lifecycle.
//!
//! Replaces the old `config.rs` session functions and `client_pool.rs`.
//! All session file naming and discovery logic lives here.
//!
//! Session file naming:
//! - Canonical: `telegram_+{phone}.session` (phone auth, post-QR-auth)
//! - Temporary: `temp_{task_id}.session` (during QR auth, before phone is known)

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use messanger_telegram::TelegramClient;
use tracing::{info, instrument, warn};

use crate::config::{get_session_dir, sanitize_owner_id};
use crate::error::WorkerError;

// ────────────────────────────────────────────────────────────────────────────
// Trait
// ────────────────────────────────────────────────────────────────────────────

#[async_trait]
pub trait SessionManager: Send + Sync {
    /// Phone auth: session file = `telegram_+{phone}.session` (canonical, immediate).
    async fn get_or_create_for_phone(
        &self,
        owner_id: &str,
        phone: &str,
    ) -> Result<Arc<TelegramClient>, WorkerError>;

    /// QR auth: session file = `temp_{task_id}.session` (temporary, full task ID preserved).
    async fn get_or_create_for_qr(
        &self,
        owner_id: &str,
        task_id: &str,
    ) -> Result<Arc<TelegramClient>, WorkerError>;

    /// After QR auth: rename `temp_{task_id}.session` → `telegram_+{phone}.session`,
    /// remove temp entry from cache.
    fn promote_qr_session(
        &self,
        owner_id: &str,
        task_id: &str,
        phone: Option<&str>,
        numeric_id: i64,
    );

    /// Post-auth services: derive path from Convex `telegramId` (e.g. `"telegram:+1234567890"`).
    async fn get_for_telegram_id(
        &self,
        owner_id: &str,
        telegram_id: &str,
    ) -> Result<Arc<TelegramClient>, WorkerError>;

    /// Check whether a canonical session file exists on disk for a given client.
    fn has_canonical_session(&self, owner_id: &str, telegram_id: &str) -> bool;

    /// Remove a specific temp session from cache.
    /// Scoped by `(owner_id, task_id)` — each QR auth flow only removes its own.
    fn remove_temp(&self, owner_id: &str, task_id: &str);

    /// Discover all canonical sessions on disk. Returns `(owner_id, path)` pairs.
    /// Only finds `telegram_*.session`, ignores `temp_*` orphans.
    fn discover_sessions(&self) -> Vec<(String, PathBuf)>;

    /// Delete orphaned `temp_*.session` files from disk.
    /// Only called at startup before any auth flows begin.
    fn cleanup_temp_sessions(&self);
}

// ────────────────────────────────────────────────────────────────────────────
// Cache key
// ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CacheKey {
    owner_id: String,
    /// The filename stem without `.session`, e.g. `"telegram_+1234567890"` or `"temp_abc123"`.
    session_stem: String,
}

// ────────────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────────────

pub struct TelegramSessionManager {
    api_id: i32,
    api_hash: String,
    clients: DashMap<CacheKey, Arc<TelegramClient>>,
}

impl TelegramSessionManager {
    pub fn new(api_id: i32, api_hash: String) -> Self {
        Self {
            api_id,
            api_hash,
            clients: DashMap::new(),
        }
    }

    // ── Path helpers ───────────────────────────────────────────

    fn owner_dir(owner_id: &str) -> PathBuf {
        let dir = get_session_dir().join(sanitize_owner_id(owner_id));
        std::fs::create_dir_all(&dir).ok();
        // Persist owner_id for discovery
        let owner_file = dir.join(".owner");
        if !owner_file.exists() {
            std::fs::write(&owner_file, owner_id).ok();
        }
        dir
    }

    fn normalize_phone(phone: &str) -> String {
        if phone.starts_with('+') {
            phone.to_string()
        } else {
            format!("+{phone}")
        }
    }

    fn canonical_stem(phone: &str) -> String {
        format!("telegram_{}", Self::normalize_phone(phone))
    }

    fn canonical_stem_numeric(numeric_id: i64) -> String {
        format!("telegram_{numeric_id}")
    }

    fn temp_stem(task_id: &str) -> String {
        format!("temp_{task_id}")
    }

    fn session_path(owner_id: &str, stem: &str) -> PathBuf {
        Self::owner_dir(owner_id).join(format!("{stem}.session"))
    }

    // ── Internal client builder ────────────────────────────────

    async fn get_or_create_inner(
        &self,
        key: CacheKey,
        path: PathBuf,
    ) -> Result<Arc<TelegramClient>, WorkerError> {
        if let Some(client) = self.clients.get(&key) {
            return Ok(client.clone());
        }

        info!(path = ?path, "Building new Telegram client");

        let client = TelegramClient::new(
            self.api_id,
            self.api_hash.clone(),
            path.to_string_lossy().to_string(),
        )
        .await
        .map_err(|e| WorkerError::ClientBuildFailed(e.to_string()))?;

        let client = Arc::new(client);
        self.clients.insert(key, client.clone());
        Ok(client)
    }
}

#[async_trait]
impl SessionManager for TelegramSessionManager {
    #[instrument(skip(self), fields(owner_id = %owner_id, phone = %phone))]
    async fn get_or_create_for_phone(
        &self,
        owner_id: &str,
        phone: &str,
    ) -> Result<Arc<TelegramClient>, WorkerError> {
        let stem = Self::canonical_stem(phone);
        let key = CacheKey {
            owner_id: owner_id.to_string(),
            session_stem: stem.clone(),
        };
        self.get_or_create_inner(key, Self::session_path(owner_id, &stem))
            .await
    }

    #[instrument(skip(self), fields(owner_id = %owner_id, task_id = %task_id))]
    async fn get_or_create_for_qr(
        &self,
        owner_id: &str,
        task_id: &str,
    ) -> Result<Arc<TelegramClient>, WorkerError> {
        let stem = Self::temp_stem(task_id);
        let key = CacheKey {
            owner_id: owner_id.to_string(),
            session_stem: stem.clone(),
        };
        self.get_or_create_inner(key, Self::session_path(owner_id, &stem))
            .await
    }

    #[instrument(skip(self))]
    fn promote_qr_session(
        &self,
        owner_id: &str,
        task_id: &str,
        phone: Option<&str>,
        numeric_id: i64,
    ) {
        let temp_stem = Self::temp_stem(task_id);
        let canonical_stem = match phone {
            Some(p) => Self::canonical_stem(p),
            None => Self::canonical_stem_numeric(numeric_id),
        };

        let temp_path = Self::session_path(owner_id, &temp_stem);
        let canonical_path = Self::session_path(owner_id, &canonical_stem);

        if temp_path.exists() && temp_path != canonical_path {
            if canonical_path.exists() {
                std::fs::remove_file(&canonical_path).ok();
            }
            if let Err(e) = std::fs::rename(&temp_path, &canonical_path) {
                warn!(error = %e, "Failed to rename session; falling back to copy");
                std::fs::copy(&temp_path, &canonical_path).ok();
                std::fs::remove_file(&temp_path).ok();
            }
            info!(from = ?temp_path, to = ?canonical_path, "Promoted QR session to canonical");
        }

        // Remove temp cache entry
        let temp_key = CacheKey {
            owner_id: owner_id.to_string(),
            session_stem: temp_stem,
        };
        self.clients.remove(&temp_key);
    }

    #[instrument(skip(self), fields(owner_id = %owner_id, telegram_id = %telegram_id))]
    async fn get_for_telegram_id(
        &self,
        owner_id: &str,
        telegram_id: &str,
    ) -> Result<Arc<TelegramClient>, WorkerError> {
        // Parse "telegram:+1234567890" or "telegram:123456789" → stem "telegram_+1234567890"
        let suffix = telegram_id.strip_prefix("telegram:").unwrap_or(telegram_id);
        let stem = format!("telegram_{suffix}");
        let key = CacheKey {
            owner_id: owner_id.to_string(),
            session_stem: stem.clone(),
        };
        self.get_or_create_inner(key, Self::session_path(owner_id, &stem))
            .await
    }

    fn has_canonical_session(&self, owner_id: &str, telegram_id: &str) -> bool {
        let suffix = telegram_id.strip_prefix("telegram:").unwrap_or(telegram_id);
        let stem = format!("telegram_{suffix}");
        Self::session_path(owner_id, &stem).exists()
    }
    fn remove_temp(&self, owner_id: &str, task_id: &str) {
        let key = CacheKey {
            owner_id: owner_id.to_string(),
            session_stem: Self::temp_stem(task_id),
        };
        self.clients.remove(&key);
    }

    fn discover_sessions(&self) -> Vec<(String, PathBuf)> {
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

            let owner_file = path.join(".owner");
            let owner_id = match std::fs::read_to_string(&owner_file) {
                Ok(id) => id.trim().to_string(),
                Err(_) => continue,
            };

            let session_entries = match std::fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            for session_entry in session_entries.flatten() {
                let session_path = session_entry.path();
                let file_name = session_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");

                // Only canonical sessions (telegram_*), skip temp_* and other files
                if session_path.extension().is_some_and(|ext| ext == "session")
                    && file_name.starts_with("telegram_")
                {
                    results.push((owner_id.clone(), session_path));
                }
            }
        }

        results
    }

    fn cleanup_temp_sessions(&self) {
        let session_dir = get_session_dir();
        let entries = match std::fs::read_dir(&session_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let session_entries = match std::fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            for session_entry in session_entries.flatten() {
                let session_path = session_entry.path();
                let file_name = session_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");

                if session_path.extension().is_some_and(|ext| ext == "session")
                    && file_name.starts_with("temp_")
                {
                    info!(path = ?session_path, "Removing orphaned temp session");
                    std::fs::remove_file(&session_path).ok();
                }
            }
        }
    }
}
