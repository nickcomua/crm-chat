//! Shared types used across multiple tasks.

/// Login token returned by SendLoginCode and used by VerifyLoginCode.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct LoginToken {
    pub phone: String,
    pub phone_code_hash: String,
}

/// Password token for 2FA authentication.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct PasswordToken {
    pub hint: Option<String>,
    pub token: String,
}

/// Success result from sign-in operations.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct SignInSuccess {
    pub user_id: i64,
}

/// QR code token for QR-based authentication.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct QrToken {
    pub url: String,
    pub expires: i32,
}
