use base64::engine::{general_purpose, Engine};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use rand::rngs::OsRng;
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use serde::Serialize;

/// Generate an RSA keypair and JWKS data URI for Convex auth.config.ts.
///
/// Returns `(private_key_pem, jwks_data_uri)`.
pub fn generate_keypair_and_jwks() -> (String, String) {
    let private_key = RsaPrivateKey::new(&mut OsRng, 2048).expect("failed to generate RSA key");
    let private_pem = private_key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .expect("failed to encode private key")
        .to_string();

    let public_key = private_key.to_public_key();
    let n = general_purpose::URL_SAFE_NO_PAD.encode(public_key.n().to_bytes_be());
    let e = general_purpose::URL_SAFE_NO_PAD.encode(public_key.e().to_bytes_be());

    let jwks = serde_json::json!({
        "keys": [{
            "kty": "RSA",
            "use": "sig",
            "alg": "RS256",
            "kid": "test-robot-key",
            "n": n,
            "e": e,
        }]
    });

    let jwks_json = serde_json::to_string(&jwks).unwrap();
    let jwks_b64 = general_purpose::STANDARD.encode(jwks_json.as_bytes());
    let data_uri = format!("data:application/json;base64,{jwks_b64}");

    (private_pem, data_uri)
}

#[derive(Serialize)]
struct RobotClaims {
    sub: String,
    iss: String,
    aud: String,
    iat: u64,
    exp: u64,
}

/// Mint an RS256 JWT for robot authentication against Convex.
///
/// The `iss` claim uses `"https://crm-chat-robot.local"` to match the
/// `issuer` in `convex/auth.config.ts`.
pub fn mint_robot_jwt(private_key_pem: &str, robot_id: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let claims = RobotClaims {
        sub: robot_id.to_string(),
        iss: "https://crm-chat-robot.local".to_string(),
        aud: "convex".to_string(),
        iat: now,
        exp: now + 3600,
    };

    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("test-robot-key".to_string());

    let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes()).expect("invalid PEM key");
    encode(&header, &claims, &key).expect("failed to encode JWT")
}
