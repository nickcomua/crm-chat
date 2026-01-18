# ES Proxy

A secure proxy for Elasticsearch that provides JWT authentication and automatic user-based filtering. Users can only access documents that belong to them.

## Features

- **JWT Authentication**: Validates Clerk JWTs using JWKS (RS256)
- **Issuer Validation**: Only accepts tokens from configured Clerk instance
- **Automatic User Filtering**: Injects `user_id` filter into all Elasticsearch queries
- **SpacetimeDB Identity Support**: Optionally computes user_id using SpacetimeDB's identity algorithm
- **JWKS Caching**: Caches public keys for 1 hour to minimize external requests

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ELASTICSEARCH_URL` | Elasticsearch URL | `http://localhost:9200` |
| `ELASTIC_USERNAME` | Elasticsearch username | `elastic` |
| `ELASTIC_PASSWORD` | Elasticsearch password | `changeme` |
| `INDEX_NAME` | Index to search | `crm-chat-msgs` |
| `USE_SPACETIMEDB_IDENTITY` | Compute identity from `issuer\|subject` | `false` |

## How It Works

1. Client sends request with `Authorization: Bearer <clerk-jwt>` header
2. Proxy validates JWT signature against Clerk's JWKS
3. Proxy verifies issuer is `https://noted-rabbit-14.clerk.accounts.dev`
4. Proxy extracts `sub` claim (or computes SpacetimeDB identity if enabled)
5. Proxy injects `user_id` filter into the Elasticsearch query
6. Proxy forwards modified query to Elasticsearch
7. User only sees their own documents

## Endpoints

### `POST /search`

Search endpoint that automatically filters by authenticated user.

**Headers:**
- `Authorization: Bearer <jwt>` (required)
- `Content-Type: application/json`

**Body:** Standard Elasticsearch search query

**Example:**
```bash
curl -X POST http://localhost:3001/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_source": ["sender_name", "content"],
    "query": {
      "match": { "content": "meeting" }
    }
  }'
```

### `GET /health`

Health check endpoint (no authentication required).

### `GET /openapi.json`

Returns the OpenAPI 3.0 specification as JSON. Use this endpoint to generate TypeScript types for frontend type safety.

### `GET /swagger-ui`

Interactive Swagger UI for exploring and testing the API.

## Query Transformation

The proxy automatically injects user filtering:

**Input query:**
```json
{
  "query": {
    "match": { "content": "meeting" }
  }
}
```

**Transformed query:**
```json
{
  "query": {
    "bool": {
      "must": [{ "match": { "content": "meeting" } }],
      "filter": [{ "term": { "user_id": "user_abc123" } }]
    }
  }
}
```

## Semantic Search (KNN)

The proxy also supports semantic search with automatic filtering:

```bash
curl -X POST http://localhost:3001/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "knn": {
      "field": "content_embedding",
      "query_vector_builder": {
        "text_embedding": {
          "model_id": "openrouter-embeddings",
          "model_text": "project deadline"
        }
      },
      "k": 10,
      "num_candidates": 50
    }
  }'
```

## SpacetimeDB Identity Mode

When `USE_SPACETIMEDB_IDENTITY=true`, the proxy computes the user_id using SpacetimeDB's identity algorithm:

```
Identity = 0x{hex(c2 00 {checksum[0:4]} {blake3(issuer|subject)[0:26]})}
```

This matches the identity format used by SpacetimeDB's `Identity::from_claims()` function.

## Running Locally

```bash
# Build
cargo build --release -p es-proxy

# Run
ELASTICSEARCH_URL=http://localhost:9200 \
INDEX_NAME=crm-chat-msgs \
USE_SPACETIMEDB_IDENTITY=true \
./target/release/es-proxy
```

## Docker

```bash
docker compose up es-proxy
```

## Frontend Type Generation

The proxy provides an OpenAPI specification at `/openapi.json`. You can use this to generate TypeScript types:

```bash
# Using openapi-typescript
npx openapi-typescript http://localhost:3001/openapi.json -o src/lib/es-proxy.d.ts

# Or with bunx
bunx openapi-typescript http://localhost:3001/openapi.json -o src/lib/es-proxy.d.ts
```

This generates fully typed request/response interfaces for use with fetch or any HTTP client.

## Frontend Usage

```typescript
const search = async (query: string) => {
  const token = await clerk.session?.getToken();

  const response = await fetch('http://localhost:3001/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      knn: {
        field: 'content_embedding',
        query_vector_builder: {
          text_embedding: {
            model_id: 'openrouter-embeddings',
            model_text: query
          }
        },
        k: 10,
        num_candidates: 50
      },
      _source: ['sender_name', 'content', 'created_at']
    })
  });

  return response.json();
};
```
