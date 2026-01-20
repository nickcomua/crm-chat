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

/// Elasticsearch authentication method
#[derive(Clone)]
pub enum ElasticsearchAuth {
    /// API key authentication (preferred)
    ApiKey(String),
    /// Basic username/password authentication
    Basic { username: String, password: String },
}

/// Elasticsearch configuration
#[derive(Clone)]
pub struct ElasticsearchConfig {
    pub url: String,
    pub index: String,
    pub pipeline: String,
    pub auth: ElasticsearchAuth,
    pub enabled: bool,
}

impl ElasticsearchConfig {
    /// Load Elasticsearch configuration from environment variables.
    /// Prefers ELASTIC_TOKEN (API key) over ES_USERNAME/ES_PASSWORD (basic auth).
    pub fn from_env() -> Self {
        let enabled = env::var("ES_ENABLED")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let auth = if let Ok(token) = env::var("ELASTIC_TOKEN") {
            if !token.is_empty() {
                ElasticsearchAuth::ApiKey(token)
            } else {
                ElasticsearchAuth::Basic {
                    username: env::var("ES_USERNAME").unwrap_or_else(|_| "elastic".to_string()),
                    password: env::var("ES_PASSWORD").unwrap_or_default(),
                }
            }
        } else {
            ElasticsearchAuth::Basic {
                username: env::var("ES_USERNAME").unwrap_or_else(|_| "elastic".to_string()),
                password: env::var("ES_PASSWORD").unwrap_or_default(),
            }
        };

        Self {
            url: env::var("ES_URL").unwrap_or_else(|_| "http://localhost:9200".to_string()),
            index: env::var("ES_INDEX").unwrap_or_else(|_| "crm-chat-msgs".to_string()),
            pipeline: env::var("ES_PIPELINE").unwrap_or_else(|_| "openrouter-pipeline".to_string()),
            auth,
            enabled,
        }
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
