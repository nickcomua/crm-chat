//! Configuration for crm-worker service.

use anyhow::Result;
use std::env;
use std::path::PathBuf;

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
    /// Load configuration from environment variables.
    pub fn from_env() -> Result<Self> {
        let api_id: i32 = env::var("TG_ID")
            .expect("TG_ID environment variable not set")
            .parse()
            .expect("TG_ID must be a valid integer");
        let api_hash = env::var("TG_HASH").expect("TG_HASH environment variable not set");
        let convex_url = env::var("CONVEX_URL").expect("CONVEX_URL must be set");
        let m2m_secret_key =
            env::var("CLERK_M2M_SECRET_KEY").expect("CLERK_M2M_SECRET_KEY must be set");
        let restate_port: u16 = env::var("RESTATE_SERVICE_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(9080);
        let restate_admin_url =
            env::var("RESTATE_ADMIN_URL").unwrap_or_else(|_| "http://localhost:9070".to_string());
        let restate_ingress_url =
            env::var("RESTATE_INGRESS_URL").unwrap_or_else(|_| "http://localhost:8080".to_string());
        let restate_service_url = env::var("RESTATE_SERVICE_URL")
            .unwrap_or_else(|_| format!("http://host.docker.internal:{restate_port}"));
        let max_media_workflows: usize = env::var("MAX_MEDIA_WORKFLOWS")
            .ok()
            .and_then(|v| v.parse().ok())
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
