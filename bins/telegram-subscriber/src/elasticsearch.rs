//! Elasticsearch client for indexing messages.

use crate::config::{ElasticsearchAuth, ElasticsearchConfig};
use reqwest::{Client, RequestBuilder};
use serde::Serialize;

/// Document to be indexed in Elasticsearch.
#[derive(Debug, Serialize)]
pub struct MessageDocument {
    pub user_id: String,
    pub client_id: u64,
    pub chat_id: String,
    pub id: String,
    pub message_id: String,
    pub external_id: String,
    pub sender_id: String,
    pub content: String,
    pub out: bool,
    pub created_at: u64,
}

/// Elasticsearch client wrapper.
#[derive(Clone)]
pub struct ElasticsearchClient {
    client: Client,
    config: ElasticsearchConfig,
}

impl ElasticsearchClient {
    pub fn new(config: ElasticsearchConfig) -> Self {
        Self {
            client: Client::new(),
            config,
        }
    }

    /// Apply authentication to a request based on config.
    fn apply_auth(&self, request: RequestBuilder) -> RequestBuilder {
        match &self.config.auth {
            ElasticsearchAuth::ApiKey(token) => {
                request.header("Authorization", format!("ApiKey {}", token))
            }
            ElasticsearchAuth::Basic { username, password } => {
                request.basic_auth(username, Some(password))
            }
        }
    }

    /// Check if ES indexing is enabled.
    #[allow(dead_code)]
    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    /// Index a message document.
    pub async fn index_message(&self, doc: MessageDocument) -> Result<(), String> {
        if !self.config.enabled {
            return Ok(());
        }

        let url = format!(
            "{}/{}/_doc/{}?pipeline={}",
            self.config.url, self.config.index, doc.message_id, self.config.pipeline
        );

        let request = self.client.post(&url).json(&doc);
        let response = self
            .apply_auth(request)
            .send()
            .await
            .map_err(|e| format!("ES request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown".to_string());
            return Err(format!("ES indexing failed ({}): {}", status, body));
        }

        Ok(())
    }

    /// Bulk index multiple messages.
    pub async fn bulk_index_messages(&self, docs: Vec<MessageDocument>) -> Result<(), String> {
        if !self.config.enabled || docs.is_empty() {
            return Ok(());
        }

        let mut bulk_body = String::new();
        for doc in &docs {
            // Action line
            bulk_body.push_str(&format!(
                r#"{{"index":{{"_index":"{}","_id":"{}","pipeline":"{}"}}}}"#,
                self.config.index, doc.message_id, self.config.pipeline
            ));
            bulk_body.push('\n');

            // Document line
            bulk_body.push_str(
                &serde_json::to_string(doc).map_err(|e| format!("Serialization error: {}", e))?,
            );
            bulk_body.push('\n');
        }

        let url = format!("{}/_bulk", self.config.url);

        let request = self
            .client
            .post(&url)
            .header("Content-Type", "application/x-ndjson")
            .body(bulk_body);
        let response = self
            .apply_auth(request)
            .send()
            .await
            .map_err(|e| format!("ES bulk request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown".to_string());
            return Err(format!("ES bulk indexing failed ({}): {}", status, body));
        }

        Ok(())
    }
}
