#!/usr/bin/env bash
# Run E2E Playwright tests with all required services.
#
# Prerequisites: Docker, Node.js, Rust toolchain, openssl
#
# Usage: ./scripts/run-e2e-tests.sh [--headed]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONVEX_DIR="$ROOT/bins/convex-backend"
WEB_DIR="$ROOT/bins/crm-chat-web"
TMPDIR_KEYS="$(mktemp -d)"
SUBSCRIBER_PID=""
HEADED="${1:-}"

cleanup() {
  echo "[e2e] Cleaning up..."
  if [ -n "$SUBSCRIBER_PID" ] && kill -0 "$SUBSCRIBER_PID" 2>/dev/null; then
    kill "$SUBSCRIBER_PID" 2>/dev/null || true
    wait "$SUBSCRIBER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_KEYS"
}
trap cleanup EXIT

# Load .env for TEST_CLERK_* and other vars
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# Validate required env vars
for var in TEST_CLERK_USERNAME TEST_CLERK_PASSWORD VITE_CLERK_PUBLISHABLE_KEY TG_ID TG_HASH; do
  if [ -z "${!var:-}" ]; then
    echo "[e2e] ERROR: $var is not set" >&2
    exit 1
  fi
done

# ── 1. Start Convex backend ──────────────────────────────────────────
echo "[e2e] Starting Convex backend..."
docker compose -f "$ROOT/docker-compose.yml" up -d backend

echo "[e2e] Waiting for Convex backend to be healthy..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3210/version > /dev/null 2>&1; then
    echo "[e2e] Backend ready (attempt $i)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[e2e] ERROR: Backend not ready after 60s" >&2
    exit 1
  fi
  sleep 1
done

# ── 2. Generate robot RSA keypair ────────────────────────────────────
echo "[e2e] Generating robot RSA keypair..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$TMPDIR_KEYS/robot_private.pem" 2>/dev/null
openssl rsa -in "$TMPDIR_KEYS/robot_private.pem" -pubout \
  -out "$TMPDIR_KEYS/robot_public.pem" 2>/dev/null

# Build JWKS JSON
MODULUS=$(openssl rsa -in "$TMPDIR_KEYS/robot_public.pem" -pubin -modulus -noout 2>/dev/null \
  | sed 's/Modulus=//' | xxd -r -p | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')
EXPONENT="AQAB"

JWKS_JSON=$(cat <<JWKS
{"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"e2e-robot-key","n":"${MODULUS}","e":"${EXPONENT}"}]}
JWKS
)
JWKS_B64=$(echo -n "$JWKS_JSON" | base64 | tr -d '\n')
JWKS_DATA_URI="data:application/json;base64,${JWKS_B64}"

ROBOT_JWT_PRIVATE_KEY="$(cat "$TMPDIR_KEYS/robot_private.pem")"
export ROBOT_JWT_PRIVATE_KEY

echo "[e2e] Robot keypair generated"

# ── 3. Deploy Convex functions ───────────────────────────────────────
CONVEX_URL="http://127.0.0.1:3210"
ADMIN_KEY="$(grep CONVEX_SELF_HOSTED_ADMIN_KEY "$CONVEX_DIR/.env.local" | cut -d= -f2-)"

export CONVEX_SELF_HOSTED_URL="$CONVEX_URL"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY"

echo "[e2e] Setting Convex env vars..."
cd "$CONVEX_DIR"
npx convex env set CLERK_JWT_ISSUER_DOMAIN "https://noted-rabbit-14.clerk.accounts.dev"
npx convex env set ROBOT_JWKS "$JWKS_DATA_URI"

echo "[e2e] Deploying Convex functions..."
npx convex deploy
echo "[e2e] Deploy complete"

# ── 4. Start telegram-subscriber ─────────────────────────────────────
echo "[e2e] Building telegram-subscriber..."
cargo build -p telegram-subscriber --quiet

echo "[e2e] Starting telegram-subscriber..."
CONVEX_URL="$CONVEX_URL" \
  ROBOT_JWT_PRIVATE_KEY="$ROBOT_JWT_PRIVATE_KEY" \
  ROBOT_ID="e2e-robot" \
  ROBOT_KID="e2e-robot-key" \
  TG_ID="$TG_ID" \
  TG_HASH="$TG_HASH" \
  "$ROOT/target/debug/telegram-subscriber" &
SUBSCRIBER_PID=$!

# Give subscriber time to connect and register
sleep 3
if ! kill -0 "$SUBSCRIBER_PID" 2>/dev/null; then
  echo "[e2e] ERROR: telegram-subscriber exited prematurely" >&2
  exit 1
fi
echo "[e2e] telegram-subscriber running (PID $SUBSCRIBER_PID)"

# ── 5. Run Playwright tests ─────────────────────────────────────────
echo "[e2e] Running Playwright tests..."
cd "$WEB_DIR"

# Ensure Playwright browsers are installed
npx playwright install chromium --with-deps 2>/dev/null || npx playwright install chromium

PLAYWRIGHT_ARGS=()
if [ "$HEADED" = "--headed" ]; then
  PLAYWRIGHT_ARGS+=(--headed)
fi

VITE_CONVEX_URL="$CONVEX_URL" \
  VITE_CLERK_PUBLISHABLE_KEY="$VITE_CLERK_PUBLISHABLE_KEY" \
  TEST_CLERK_USERNAME="$TEST_CLERK_USERNAME" \
  TEST_CLERK_PASSWORD="$TEST_CLERK_PASSWORD" \
  npx playwright test "${PLAYWRIGHT_ARGS[@]}"

echo "[e2e] Tests complete!"
