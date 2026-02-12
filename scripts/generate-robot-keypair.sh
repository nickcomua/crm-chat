#!/usr/bin/env bash
# Generates an RS256 keypair for robot (telegram-subscriber) JWT authentication.
# Run once, then store the private key as ROBOT_JWT_PRIVATE_KEY env var
# and use the JWKS output in Convex auth.config.ts.

set -euo pipefail

OUTDIR="${1:-.}"

echo "Generating RS256 keypair for robot JWT auth..."

# Generate private key
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$OUTDIR/robot_private.pem" 2>/dev/null

# Extract public key
openssl rsa -in "$OUTDIR/robot_private.pem" -pubout -out "$OUTDIR/robot_public.pem" 2>/dev/null

# Generate JWKS from the public key
# Extract modulus and exponent for JWK format
MODULUS=$(openssl rsa -in "$OUTDIR/robot_public.pem" -pubin -modulus -noout 2>/dev/null | sed 's/Modulus=//' | xxd -r -p | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')
EXPONENT=$(printf 'AQAB') # Standard RSA exponent 65537

KID="robot-key-1"

cat > "$OUTDIR/robot_jwks.json" <<JWKS
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "$KID",
      "n": "$MODULUS",
      "e": "$EXPONENT"
    }
  ]
}
JWKS

echo ""
echo "Files generated:"
echo "  $OUTDIR/robot_private.pem  - Private key (set as ROBOT_JWT_PRIVATE_KEY)"
echo "  $OUTDIR/robot_public.pem   - Public key"
echo "  $OUTDIR/robot_jwks.json    - JWKS for Convex auth.config.ts"
echo ""
echo "To use as a data URI in auth.config.ts:"
echo "  data:application/json;base64,$(base64 < "$OUTDIR/robot_jwks.json" | tr -d '\n')"
