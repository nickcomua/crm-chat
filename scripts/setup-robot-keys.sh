#!/usr/bin/env bash
# Generate robot RSA keypair and configure Convex JWKS.
#
# This script:
#   1. Generates a fresh RSA 2048-bit keypair
#   2. Updates .env with ROBOT_JWT_PRIVATE_KEY, ROBOT_ID, ROBOT_KID
#   3. Pushes the JWKS (public key) to Convex via `bunx convex env set`
#
# Prerequisites: openssl, bun (for bunx convex)
#
# Usage: ./scripts/setup-robot-keys.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONVEX_DIR="$ROOT/bins/convex-backend"
ENV_FILE="$ROOT/.env"
TMPDIR_KEYS="$(mktemp -d)"

cleanup() {
  rm -rf "$TMPDIR_KEYS"
}
trap cleanup EXIT

# ── 1. Generate RSA keypair ────────────────────────────────────────
echo "[setup] Generating robot RSA 2048-bit keypair..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$TMPDIR_KEYS/private.pem" 2>/dev/null
openssl rsa -in "$TMPDIR_KEYS/private.pem" -pubout \
  -out "$TMPDIR_KEYS/public.pem" 2>/dev/null

# ── 2. Build JWKS from public key ─────────────────────────────────
ROBOT_KID="robot-key-1"
ROBOT_ID="robot-1"

MODULUS=$(openssl rsa -in "$TMPDIR_KEYS/public.pem" -pubin -modulus -noout 2>/dev/null \
  | sed 's/Modulus=//' | xxd -r -p | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')
EXPONENT="AQAB"

JWKS_JSON="{\"keys\":[{\"kty\":\"RSA\",\"use\":\"sig\",\"alg\":\"RS256\",\"kid\":\"${ROBOT_KID}\",\"n\":\"${MODULUS}\",\"e\":\"${EXPONENT}\"}]}"
JWKS_B64=$(echo -n "$JWKS_JSON" | base64 | tr -d '\n')
JWKS_DATA_URI="data:application/json;base64,${JWKS_B64}"

echo "[setup] JWKS built (kid=$ROBOT_KID)"

# ── 3. Update .env ────────────────────────────────────────────────
# Convert PEM to single-line \n format for .env / direnv compatibility
PRIVATE_KEY_ONELINE=$(awk '{printf "%s\\n", $0}' "$TMPDIR_KEYS/private.pem" | sed 's/\\n$//')

# Remove old values if present
for key in ROBOT_JWT_PRIVATE_KEY ROBOT_ID ROBOT_KID; do
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
done

# Append new values
cat >> "$ENV_FILE" <<EOF

ROBOT_ID="${ROBOT_ID}"
ROBOT_KID="${ROBOT_KID}"
ROBOT_JWT_PRIVATE_KEY="${PRIVATE_KEY_ONELINE}"
EOF

echo "[setup] .env updated with ROBOT_ID, ROBOT_KID, ROBOT_JWT_PRIVATE_KEY"

# ── 4. Push JWKS to Convex ────────────────────────────────────────
echo "[setup] Setting ROBOT_JWKS in Convex..."
cd "$CONVEX_DIR"
bunx convex env set ROBOT_JWKS "$JWKS_DATA_URI"

echo "[setup] Done! Robot keypair configured."
echo "[setup]   ROBOT_ID=$ROBOT_ID"
echo "[setup]   ROBOT_KID=$ROBOT_KID"
echo "[setup]   JWKS pushed to Convex"
