#!/usr/bin/env bash
# Rebuild JWKS_DATA_URI from existing .env vars and push to Convex.
#
# Reads ROBOT_JWT_PRIVATE_KEY and ROBOT_KID from .env, derives the
# public key, builds a JWKS data URI, and sets it in Convex.
#
# Prerequisites: openssl, bun (for bunx convex)
#
# Usage: ./scripts/rebuild-jwks.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONVEX_DIR="$ROOT/bins/convex-backend"
ENV_FILE="$ROOT/.env"
TMPDIR_KEYS="$(mktemp -d)"

cleanup() {
  rm -rf "$TMPDIR_KEYS"
}
trap cleanup EXIT

# ── 1. Read existing vars from .env ─────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[rebuild-jwks] Error: $ENV_FILE not found" >&2
  exit 1
fi

# Source only the vars we need (they're double-quoted in .env)
ROBOT_KID=$(grep '^ROBOT_KID=' "$ENV_FILE" | head -1 | sed 's/^ROBOT_KID=//' | tr -d '"')
PRIVATE_KEY_RAW=$(grep '^ROBOT_JWT_PRIVATE_KEY=' "$ENV_FILE" | head -1 | sed 's/^ROBOT_JWT_PRIVATE_KEY=//' | tr -d '"')

if [[ -z "$ROBOT_KID" ]]; then
  echo "[rebuild-jwks] Error: ROBOT_KID not found in $ENV_FILE" >&2
  exit 1
fi
if [[ -z "$PRIVATE_KEY_RAW" ]]; then
  echo "[rebuild-jwks] Error: ROBOT_JWT_PRIVATE_KEY not found in $ENV_FILE" >&2
  exit 1
fi

echo "[rebuild-jwks] Found ROBOT_KID=$ROBOT_KID"

# ── 2. Restore PEM from single-line format ──────────────────────────
# .env stores the key with literal \n — convert back to real newlines
echo -e "$PRIVATE_KEY_RAW" > "$TMPDIR_KEYS/private.pem"

# Derive public key
openssl rsa -in "$TMPDIR_KEYS/private.pem" -pubout \
  -out "$TMPDIR_KEYS/public.pem" 2>/dev/null

# ── 3. Build JWKS from public key ──────────────────────────────────
MODULUS=$(openssl rsa -in "$TMPDIR_KEYS/public.pem" -pubin -modulus -noout 2>/dev/null \
  | sed 's/Modulus=//' | xxd -r -p | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')
EXPONENT="AQAB"

JWKS_JSON="{\"keys\":[{\"kty\":\"RSA\",\"use\":\"sig\",\"alg\":\"RS256\",\"kid\":\"${ROBOT_KID}\",\"n\":\"${MODULUS}\",\"e\":\"${EXPONENT}\"}]}"
JWKS_B64=$(echo -n "$JWKS_JSON" | base64 | tr -d '\n')
JWKS_DATA_URI="data:application/json;base64,${JWKS_B64}"

echo "[rebuild-jwks] JWKS built (kid=$ROBOT_KID)"

# ── 4. Update .env with ROBOT_JWKS ───────────────────────────────────
if grep -q '^ROBOT_JWKS=' "$ENV_FILE" 2>/dev/null; then
  grep -v '^ROBOT_JWKS=' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

echo "ROBOT_JWKS=\"${JWKS_DATA_URI}\"" >> "$ENV_FILE"
echo "[rebuild-jwks] .env updated with ROBOT_JWKS"

echo "[rebuild-jwks] Done!"
