//! Worker authentication via Clerk M2M (machine-to-machine) JWTs.
//!
//! The worker service authenticates to Convex using a Clerk M2M JWT obtained
//! from the Clerk Backend API. The JWT is issued for the machine identified by
//! the `CLERK_M2M_SECRET_KEY` environment variable.

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Deserialize)]
struct M2mTokenResponse {
    token: String,
}

/// Fetch a fresh M2M JWT from the Clerk Backend API.
///
/// The token is valid for ~24 hours. Call periodically to refresh before expiry.
pub async fn fetch_m2m_jwt(http: &reqwest::Client, m2m_secret_key: &str) -> Result<String> {
    let resp = http
        .post("https://api.clerk.com/v1/m2m_tokens")
        .bearer_auth(m2m_secret_key)
        .json(&serde_json::json!({ "token_format": "jwt" }))
        .send()
        .await
        .context("Failed to reach Clerk M2M API")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Clerk M2M API returned {status}: {body}");
    }

    let body: M2mTokenResponse = resp
        .json()
        .await
        .context("Failed to parse Clerk M2M response")?;

    Ok(body.token)
}
