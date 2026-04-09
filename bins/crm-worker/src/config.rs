//! Configuration for crm-worker service.

use anyhow::Result;
use std::path::PathBuf;

use crate::secrets;

/// Telegram API credentials and worker configuration.
#[derive(Clone)]
pub struct WorkerConfig {
    pub api_id: i32,
    pub api_hash: String,
    pub convex_url: String,
    pub m2m_secret_key: String,
    pub restate_port: u16,
    /// Restate admin API URL for registering deployments (default: `http://localhost:9070`).
    pub restate_admin_url: String,
    /// Restate ingress URL where the bridge sends requests (default: `http://localhost:8080`).
    pub restate_ingress_url: String,
    /// URL the Restate runtime uses to reach this service endpoint.
    /// Must be reachable from within Docker (default: `http://host.docker.internal:{restate_port}`).
    pub restate_service_url: String,
    /// Maximum number of MediaDownloader workflows running in parallel.
    /// Controls how many clients can download media simultaneously.
    /// 0 = unlimited. (default: 2)
    pub max_media_workflows: usize,
}

impl WorkerConfig {
    /// Load configuration from secretspec profile `crm-worker`.
    pub fn from_env() -> Result<Self> {
        let spec = secrets::SecretSpec::builder()
            .with_profile("crm_worker")
            .load()?;

        let api_id: i32 = spec
            .secrets
            .tg_id
            .expect("TG_ID is required")
            .parse()
            .expect("TG_ID must be a valid integer");
        let api_hash = spec.secrets.tg_hash.expect("TG_HASH is required");
        let convex_url = spec.secrets.convex_url.expect("CONVEX_URL is required");
        let m2m_secret_key = spec
            .secrets
            .clerk_m2m_secret_key
            .expect("CLERK_M2M_SECRET_KEY is required");

        let restate_port: u16 = spec
            .secrets
            .restate_service_port
            .and_then(|v: String| v.parse().ok())
            .unwrap_or(9080);
        let restate_admin_url = spec
            .secrets
            .restate_admin_url
            .unwrap_or_else(|| "http://localhost:9070".to_string());
        let restate_ingress_url = spec
            .secrets
            .restate_ingress_url
            .unwrap_or_else(|| "http://localhost:8080".to_string());
        let restate_service_url = spec
            .secrets
            .restate_service_url
            .unwrap_or_else(|| format!("http://host.docker.internal:{restate_port}"));
        let max_media_workflows: usize = spec
            .secrets
            .max_media_workflows
            .and_then(|v: String| v.parse().ok())
            .unwrap_or(2);

        Ok(Self {
            api_id,
            api_hash,
            convex_url,
            m2m_secret_key,
            restate_port,
            restate_admin_url,
            restate_ingress_url,
            restate_service_url,
            max_media_workflows,
        })
    }
}

/// Get the directory where session files are stored.
///
/// When `TG_SESSION_DIR` is set, uses that path directly.
/// Otherwise uses the platform data directory (`~/Library/Application Support` on macOS).
pub fn get_session_dir() -> PathBuf {
    // Try to load from secretspec; fall back to env var for backward compat
    let dir = secrets::SecretSpec::builder()
        .with_profile("crm_worker")
        .load()
        .ok()
        .and_then(|spec| spec.secrets.tg_session_dir);

    if let Some(dir) = dir {
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
