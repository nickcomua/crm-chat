//! Robot JWT minting for Convex authentication.
//!
//! The robot service authenticates to Convex using a self-signed RS256 JWT.
//! The private key is loaded from the `ROBOT_JWT_PRIVATE_KEY` environment variable.

use anyhow::Result;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;

#[derive(Serialize)]
struct RobotClaims {
    sub: String,
    iss: String,
    aud: String,
    iat: u64,
    exp: u64,
}

/// Mint a new JWT for the robot service.
///
/// The token is valid for 1 hour and uses RS256 signing.
/// The `kid` must match the key ID in the JWKS configured in Convex auth.config.ts.
pub fn mint_robot_jwt(private_key_pem: &str, robot_id: &str, kid: &str) -> Result<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();

    let claims = RobotClaims {
        sub: robot_id.to_string(),
        iss: "https://crm-chat-robot.local".to_string(),
        aud: "convex".to_string(),
        iat: now,
        exp: now + 3600 * 24 ,
    };

    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.to_string());

    let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes())?;
    let token = encode(&header, &claims, &key)?;
    Ok(token)
}
