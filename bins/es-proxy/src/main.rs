use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

// CLERK_ISSUER is now configured via environment variable and stored in AppState

/// Search request body - accepts standard Elasticsearch query DSL
#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct SearchRequest {
    /// Standard Elasticsearch query object
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Object, example = json!({"match": {"content": "meeting"}}))]
    pub query: Option<Value>,

    /// KNN (semantic) search configuration
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Object, example = json!({
        "field": "content_embedding",
        "query_vector_builder": {
            "text_embedding": {
                "model_id": "openrouter-embeddings",
                "model_text": "project deadline"
            }
        },
        "k": 10,
        "num_candidates": 50
    }))]
    pub knn: Option<Value>,

    /// Fields to return in the response
    #[serde(rename = "_source", skip_serializing_if = "Option::is_none")]
    #[schema(example = json!(["sender_id", "content", "created_at"]))]
    pub source: Option<Value>,

    /// Maximum number of results to return
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = 10)]
    pub size: Option<u32>,

    /// Offset for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = 0)]
    pub from: Option<u32>,

    /// Additional Elasticsearch parameters (passed through)
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// A single search hit
#[derive(Debug, Serialize, ToSchema)]
pub struct SearchHit {
    /// Document ID
    #[schema(example = "abc123")]
    pub _id: String,

    /// Document index
    #[schema(example = "crm-chat-msgs")]
    pub _index: String,

    /// Relevance score
    #[schema(example = 1.5)]
    pub _score: Option<f64>,

    /// Document source fields
    #[schema(value_type = Object)]
    pub _source: Option<Value>,
}

/// Search hits container
#[derive(Debug, Serialize, ToSchema)]
pub struct SearchHits {
    /// Total number of matching documents
    #[schema(value_type = Object, example = json!({"value": 100, "relation": "eq"}))]
    pub total: Value,

    /// Maximum score across all hits
    pub max_score: Option<f64>,

    /// Array of matching documents
    pub hits: Vec<SearchHit>,
}

/// Elasticsearch search response
#[derive(Debug, Serialize, ToSchema)]
pub struct SearchResponse {
    /// Time taken to execute the search in milliseconds
    #[schema(example = 15)]
    pub took: u64,

    /// Whether the search timed out
    #[schema(example = false)]
    pub timed_out: bool,

    /// Shard statistics
    #[schema(value_type = Object)]
    pub _shards: Value,

    /// Search results
    pub hits: SearchHits,
}

/// Error response
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    /// Error message
    #[schema(example = "Unauthorized")]
    pub error: String,
}

/// Filter type for scoped searches
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchScope {
    /// Search across all user's messages
    All,
    /// Search within a specific chat
    Chat { chat_id: String },
    /// Search within a specific client's messages
    Client { client_id: u64 },
}

/// Simplified search request for frontend use
#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct SimpleSearchRequest {
    /// Text query to search for
    #[schema(example = "meeting tomorrow")]
    pub q: String,

    /// Search scope - filter by chat, client, or search all
    #[serde(default)]
    #[schema(value_type = Option<SearchScope>)]
    pub scope: Option<SearchScope>,

    /// Use semantic (vector) search instead of keyword search
    #[serde(default)]
    #[schema(example = false)]
    pub semantic: bool,

    /// Maximum number of results to return
    #[serde(default = "default_size")]
    #[schema(example = 20)]
    pub size: u32,

    /// Offset for pagination
    #[serde(default)]
    #[schema(example = 0)]
    pub from: u32,
}

fn default_size() -> u32 {
    20
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "ES Proxy API",
        version = "1.0.0",
        description = "A secure proxy for Elasticsearch that provides JWT authentication and automatic user-based filtering. Users can only access documents that belong to them.",
        license(name = "MIT")
    ),
    paths(search, simple_search, health),
    components(
        schemas(SearchRequest, SearchResponse, SearchHits, SearchHit, ErrorResponse, SimpleSearchRequest, SearchScope)
    ),
    modifiers(&SecurityAddon),
    tags(
        (name = "search", description = "Search endpoints"),
        (name = "health", description = "Health check endpoints")
    ),
    servers(
        (url = "http://localhost:3001", description = "Local development server")
    )
)]
struct ApiDoc;

struct SecurityAddon;

impl utoipa::Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};

        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearer_auth",
                SecurityScheme::Http(
                    HttpBuilder::new()
                        .scheme(HttpAuthScheme::Bearer)
                        .bearer_format("JWT")
                        .description(Some("Clerk JWT token"))
                        .build(),
                ),
            );
        }
    }
}

/// Elasticsearch authentication method
#[derive(Clone)]
enum ElasticsearchAuth {
    /// API Key authentication (Authorization: ApiKey <token>)
    ApiKey(String),
    /// Basic authentication (Authorization: Basic <base64(user:pass)>)
    Basic(String),
}

impl ElasticsearchAuth {
    /// Returns the Authorization header value
    fn header_value(&self) -> String {
        match self {
            ElasticsearchAuth::ApiKey(token) => format!("ApiKey {}", token),
            ElasticsearchAuth::Basic(encoded) => format!("Basic {}", encoded),
        }
    }
}

#[derive(Clone)]
struct AppState {
    elasticsearch_url: String,
    elasticsearch_auth: ElasticsearchAuth,
    index_name: String,
    jwks_cache: Arc<RwLock<JwksCache>>,
    use_spacetimedb_identity: bool,
    clerk_issuer: String,
}

#[derive(Debug, Deserialize)]
struct JwtClaims {
    sub: String,
    iss: Option<String>,
    exp: Option<u64>,
}

#[derive(Debug, Clone)]
struct AuthenticatedUser {
    user_id: String,
}

/// JWKS response from Clerk
#[derive(Debug, Deserialize)]
struct JwksResponse {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize, Clone)]
struct Jwk {
    kid: String,
    kty: String,
    n: Option<String>, // RSA modulus
    e: Option<String>, // RSA exponent
    #[serde(rename = "use")]
    key_use: Option<String>,
    alg: Option<String>,
}

#[derive(Default)]
struct JwksCache {
    keys: HashMap<String, DecodingKey>,
    last_fetch: Option<std::time::Instant>,
}

impl JwksCache {
    fn is_stale(&self) -> bool {
        match self.last_fetch {
            Some(t) => t.elapsed() > std::time::Duration::from_secs(3600), // 1 hour cache
            None => true,
        }
    }
}

/// Fetch JWKS from Clerk
async fn fetch_jwks(clerk_issuer: &str) -> Result<JwksResponse, String> {
    let url = format!("{}/.well-known/jwks.json", clerk_issuer);
    info!("Fetching JWKS from {}", url);

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch JWKS: {}", e))?;

    let jwks: JwksResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse JWKS: {}", e))?;

    info!("Fetched {} keys from JWKS", jwks.keys.len());
    Ok(jwks)
}

/// Get decoding key for a specific kid
async fn get_decoding_key(
    cache: &Arc<RwLock<JwksCache>>,
    kid: &str,
    clerk_issuer: &str,
) -> Result<DecodingKey, String> {
    // Check cache first
    {
        let cache_read = cache.read().await;
        if !cache_read.is_stale() {
            if let Some(key) = cache_read.keys.get(kid) {
                return Ok(key.clone());
            }
        }
    }

    // Fetch fresh JWKS
    let jwks = fetch_jwks(clerk_issuer).await?;

    // Update cache
    let mut cache_write = cache.write().await;
    cache_write.keys.clear();
    cache_write.last_fetch = Some(std::time::Instant::now());

    for jwk in jwks.keys {
        if jwk.kty == "RSA" {
            if let (Some(n), Some(e)) = (&jwk.n, &jwk.e) {
                match DecodingKey::from_rsa_components(n, e) {
                    Ok(key) => {
                        cache_write.keys.insert(jwk.kid.clone(), key);
                    }
                    Err(e) => {
                        warn!("Failed to create decoding key for kid {}: {}", jwk.kid, e);
                    }
                }
            }
        }
    }

    cache_write
        .keys
        .get(kid)
        .cloned()
        .ok_or_else(|| format!("Key with kid {} not found in JWKS", kid))
}

/// Compute SpacetimeDB Identity from issuer and subject (matching Rust implementation)
fn compute_spacetimedb_identity(issuer: &str, subject: &str) -> String {
    let input = format!("{issuer}|{subject}");
    let first_hash = blake3::hash(input.as_bytes());
    let id_hash = &first_hash.as_bytes()[..26];

    let mut checksum_input = [0u8; 28];
    checksum_input[2..].copy_from_slice(id_hash);
    checksum_input[0] = 0xc2;
    checksum_input[1] = 0x00;
    let checksum_hash = blake3::hash(&checksum_input);

    let mut final_bytes = [0u8; 32];
    final_bytes[0] = 0xc2;
    final_bytes[1] = 0x00;
    final_bytes[2..6].copy_from_slice(&checksum_hash.as_bytes()[..4]);
    final_bytes[6..].copy_from_slice(id_hash);

    hex::encode(final_bytes)
}

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Decode JWT header to get the kid
    let header = decode_header(token).map_err(|e| {
        error!("Failed to decode JWT header: {}", e);
        StatusCode::UNAUTHORIZED
    })?;

    let kid = header.kid.ok_or_else(|| {
        error!("JWT missing kid in header");
        StatusCode::UNAUTHORIZED
    })?;

    // Get the decoding key from JWKS
    let decoding_key = get_decoding_key(&state.jwks_cache, &kid, &state.clerk_issuer)
        .await
        .map_err(|e| {
            error!("Failed to get decoding key: {}", e);
            StatusCode::UNAUTHORIZED
        })?;

    // Validate the JWT
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[&state.clerk_issuer]);
    validation.validate_exp = true;

    let token_data = decode::<JwtClaims>(token, &decoding_key, &validation).map_err(|e| {
        error!("JWT validation failed: {}", e);
        StatusCode::UNAUTHORIZED
    })?;

    let claims = token_data.claims;

    // Double-check issuer (belt and suspenders)
    if claims.iss.as_deref() != Some(state.clerk_issuer.as_str()) {
        error!(
            "Invalid issuer: {:?}, expected {}",
            claims.iss, state.clerk_issuer
        );
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Compute user_id
    let user_id = if state.use_spacetimedb_identity {
        let issuer = claims.iss.as_deref().unwrap_or(&state.clerk_issuer);
        compute_spacetimedb_identity(issuer, &claims.sub)
    } else {
        claims.sub.clone()
    };

    info!("Authenticated user: {} (sub: {})", user_id, claims.sub);

    request
        .extensions_mut()
        .insert(AuthenticatedUser { user_id });
    Ok(next.run(request).await)
}
/// Forward a search request to Elasticsearch and return the response
async fn forward_to_es(
    state: &AppState,
    body: &Value,
) -> Result<(StatusCode, Value), (StatusCode, String)> {
    let client = reqwest::Client::new();
    let url = format!("{}/{}/_search", state.elasticsearch_url, state.index_name);

    let response = client
        .post(&url)
        .header("Authorization", state.elasticsearch_auth.header_value())
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok((
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK),
        body,
    ))
}

/// Search for documents in Elasticsearch with automatic user filtering
///
/// Accepts standard Elasticsearch query DSL. The proxy automatically injects
/// a user_id filter to ensure users can only access their own documents.
#[utoipa::path(
    post,
    path = "/search",
    tag = "search",
    request_body(
        content = SearchRequest,
        description = "Elasticsearch query DSL. Both regular queries and KNN (semantic) searches are supported.",
        content_type = "application/json"
    ),
    responses(
        (status = 200, description = "Search results", body = SearchResponse),
        (status = 401, description = "Unauthorized - missing or invalid JWT", body = ErrorResponse),
        (status = 502, description = "Elasticsearch error", body = ErrorResponse)
    ),
    security(
        ("bearer_auth" = [])
    )
)]
async fn search(
    State(state): State<Arc<AppState>>,
    axum::Extension(user): axum::Extension<AuthenticatedUser>,
    Json(mut body): Json<Value>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    // Inject user_id filter into the query
    let user_filter = json!({
        "term": { "user_id": user.user_id }
    });

    // Handle different query types
    if let Some(knn) = body.get_mut("knn") {
        // For knn queries, add filter
        if let Some(knn_obj) = knn.as_object_mut() {
            if let Some(existing_filter) = knn_obj.get_mut("filter") {
                // Wrap existing filter with bool/must
                let new_filter = json!({
                    "bool": {
                        "must": [existing_filter.clone(), user_filter]
                    }
                });
                *existing_filter = new_filter;
            } else {
                knn_obj.insert("filter".to_string(), user_filter);
            }
        }
    } else if let Some(query) = body.get_mut("query") {
        // For regular queries, wrap in bool with filter
        let new_query = json!({
            "bool": {
                "must": [query.clone()],
                "filter": [user_filter]
            }
        });
        *query = new_query;
    } else {
        // No query specified, create one with just the filter
        body.as_object_mut().unwrap().insert(
            "query".to_string(),
            json!({
                "bool": {
                    "filter": [user_filter]
                }
            }),
        );
    }

    info!(
        "Modified query: {}",
        serde_json::to_string_pretty(&body).unwrap_or_default()
    );

    let (status, body) = forward_to_es(&state, &body).await?;
    Ok((status, Json(body)))
}

/// Simple search endpoint with convenient filtering options
///
/// A simplified search API that handles common use cases:
/// - Full-text keyword search
/// - Semantic (vector) search using embeddings
/// - Filtering by chat_id or client_id
///
/// The user_id filter is automatically applied based on the JWT token.
#[utoipa::path(
    post,
    path = "/search/simple",
    tag = "search",
    request_body(
        content = SimpleSearchRequest,
        description = "Simple search parameters with optional scope filtering",
        content_type = "application/json"
    ),
    responses(
        (status = 200, description = "Search results", body = SearchResponse),
        (status = 401, description = "Unauthorized - missing or invalid JWT", body = ErrorResponse),
        (status = 502, description = "Elasticsearch error", body = ErrorResponse)
    ),
    security(
        ("bearer_auth" = [])
    )
)]
async fn simple_search(
    State(state): State<Arc<AppState>>,
    axum::Extension(user): axum::Extension<AuthenticatedUser>,
    Json(request): Json<SimpleSearchRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    // Build the filter clauses
    let mut filters = vec![json!({
        "term": { "user_id": user.user_id }
    })];

    // Add scope-based filters
    match &request.scope {
        Some(SearchScope::Chat { chat_id }) => {
            filters.push(json!({
                "term": { "chat_id": chat_id }
            }));
        }
        Some(SearchScope::Client { client_id }) => {
            filters.push(json!({
                "term": { "client_id": client_id }
            }));
        }
        Some(SearchScope::All) | None => {}
    }

    // Build the query body
    let body = if request.semantic {
        // Semantic search using KNN
        json!({
            "knn": {
                "field": "content_embedding",
                "query_vector_builder": {
                    "text_embedding": {
                        "model_id": "openrouter-embeddings",
                        "model_text": request.q
                    }
                },
                "k": request.size,
                "num_candidates": request.size * 5,
                "filter": {
                    "bool": {
                        "filter": filters
                    }
                }
            },
            "_source": ["id", "external_id", "chat_id", "client_id", "sender_id", "content", "out", "created_at"],
            "size": request.size,
            "from": request.from
        })
    } else {
        // Keyword search using match query
        json!({
            "query": {
                "bool": {
                    "must": [{
                        "match": {
                            "content": {
                                "query": request.q,
                                "fuzziness": "AUTO"
                            }
                        }
                    }],
                    "filter": filters
                }
            },
            "_source": ["id", "external_id", "chat_id", "client_id", "sender_id", "content", "out", "created_at"],
            "size": request.size,
            "from": request.from,
            "sort": [
                { "_score": "desc" },
                { "created_at": "desc" }
            ]
        })
    };

    info!(
        "Simple search query: {}",
        serde_json::to_string_pretty(&body).unwrap_or_default()
    );

    let (status, body) = forward_to_es(&state, &body).await?;
    Ok((status, Json(body)))
}

/// Health check endpoint
///
/// Returns "OK" if the service is running. No authentication required.
#[utoipa::path(
    get,
    path = "/health",
    tag = "health",
    responses(
        (status = 200, description = "Service is healthy", body = String, example = "OK")
    )
)]
async fn health() -> &'static str {
    "OK"
}

/// Returns the OpenAPI specification as JSON
async fn openapi_json() -> impl IntoResponse {
    Json(ApiDoc::openapi())
}

#[tokio::main]
async fn main() {
    // Load .env file from current directory or parent directories
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("es_proxy=info".parse().unwrap()),
        )
        .init();

    // Determine Elasticsearch authentication method
    // Priority: ELASTIC_TOKEN (API Key) > ELASTIC_USERNAME/ELASTIC_PASSWORD (Basic)
    let es_auth = if let Ok(token) = std::env::var("ELASTIC_TOKEN") {
        info!("Using API Key authentication for Elasticsearch");
        ElasticsearchAuth::ApiKey(token)
    } else {
        let es_user = std::env::var("ELASTIC_USERNAME").unwrap_or_else(|_| "elastic".to_string());
        let es_pass = std::env::var("ELASTIC_PASSWORD").unwrap_or_else(|_| "changeme".to_string());
        info!(
            "Using Basic authentication for Elasticsearch (user: {})",
            es_user
        );
        ElasticsearchAuth::Basic(BASE64.encode(format!("{}:{}", es_user, es_pass)))
    };

    let state = Arc::new(AppState {
        elasticsearch_url: std::env::var("ELASTICSEARCH_URL")
            .expect("ELASTICSEARCH_URL must be set for es-proxy"),
        elasticsearch_auth: es_auth,
        index_name: std::env::var("INDEX_NAME").unwrap_or_else(|_| "crm-chat-msgs".to_string()),
        jwks_cache: Arc::new(RwLock::new(JwksCache::default())),
        use_spacetimedb_identity: std::env::var("USE_SPACETIMEDB_IDENTITY")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false),
        clerk_issuer: std::env::var("CLERK_ISSUER")
            .unwrap_or_else(|_| "https://noted-rabbit-14.clerk.accounts.dev".to_string()),
    });

    info!("Starting ES proxy on port 3001");
    info!("Elasticsearch URL: {}", state.elasticsearch_url);
    info!("Index: {}", state.index_name);
    info!(
        "Using SpacetimeDB identity: {}",
        state.use_spacetimedb_identity
    );
    info!("Accepting tokens from issuer: {}", state.clerk_issuer);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/search", post(search))
        .route("/search/simple", post(simple_search))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .route("/health", get(health))
        .merge(SwaggerUi::new("/docs").url("/openapi.json", ApiDoc::openapi()))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
