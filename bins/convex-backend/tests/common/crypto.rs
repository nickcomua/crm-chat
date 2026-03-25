/// Fetch an M2M JWT from the Clerk Backend API.
///
/// Requires `CLERK_M2M_SECRET_KEY` to be set in the environment.
pub async fn fetch_m2m_jwt(m2m_secret_key: &str) -> String {
    #[derive(serde::Deserialize)]
    struct Resp {
        token: String,
    }

    let client = reqwest::Client::new();
    let resp: Resp = client
        .post("https://api.clerk.com/v1/m2m_tokens")
        .bearer_auth(m2m_secret_key)
        .json(&serde_json::json!({ "token_format": "jwt" }))
        .send()
        .await
        .expect("Failed to reach Clerk M2M API")
        .error_for_status()
        .expect("Clerk M2M API returned error")
        .json()
        .await
        .expect("Failed to parse Clerk M2M response");

    resp.token
}
