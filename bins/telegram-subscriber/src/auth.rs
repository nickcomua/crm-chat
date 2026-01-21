//! Authentication handlers for Telegram login flow.
//!
//! These functions wrap the TelegramClient auth methods with timeout handling
//! and error conversion for use in the telegram-subscriber service.

use anyhow::{Error, Result};
use messanger_interface::MessengerClient;
use messanger_telegram::{
    CheckPasswordResult, ClonableLoginToken, ClonablePasswordToken, QrLoginToken, SignInResult,
    TelegramClient,
};

/// Handle a client in WaitingPhone state - request login code from Telegram.
///
/// Returns a `ClonableLoginToken` that should be stored in the session and passed
/// to `handle_waiting_code` when the user provides the verification code.
pub async fn handle_waiting_phone(
    phone: &str,
    tg_client: &TelegramClient,
) -> Result<ClonableLoginToken> {
    eprintln!("handle_waiting_phone: Starting with phone {}", phone);

    // Check authorization with timeout
    eprintln!("handle_waiting_phone: Checking authorization status (timeout 30s)...");
    let auth_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.is_authorized(),
    )
    .await;

    match auth_result {
        Err(_) => {
            eprintln!("handle_waiting_phone: Timeout connecting to Telegram!");
            return Err(Error::msg("Timeout connecting to Telegram"));
        }
        Ok(Err(e)) => {
            eprintln!("handle_waiting_phone: Failed to check authorization: {}", e);
            return Err(Error::msg("Failed to check authorization"));
        }
        Ok(Ok(true)) => {
            eprintln!("handle_waiting_phone: Already authorized! Updating status to Connected.");
            return Err(Error::msg("client already authorized"));
        }
        Ok(Ok(false)) => {
            eprintln!("handle_waiting_phone: Not authorized, will request login code");
        }
    }

    // Request login code with timeout
    eprintln!("handle_waiting_phone: Requesting login code from Telegram (timeout 30s)...");
    let code_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.request_login_code(phone),
    )
    .await;

    let token = match code_result {
        Err(_) => {
            eprintln!("handle_waiting_phone: Timeout requesting login code!");
            return Err(Error::msg("Timeout requesting login code"));
        }
        Ok(Ok(t)) => {
            eprintln!("handle_waiting_phone: Login code requested successfully!");
            t
        }
        Ok(Err(e)) => {
            eprintln!("handle_waiting_phone: Failed to request login code: {}", e);
            return Err(Error::msg(format!("Failed to request login code: {}", e)));
        }
    };

    eprintln!("handle_waiting_phone: Login code sent to phone, updating status...");
    Ok(token)
}

/// Result of code verification - either success, password required, or error.
pub enum CodeVerifyResult {
    /// Sign-in succeeded
    Success,
    /// 2FA password is required
    PasswordRequired(ClonablePasswordToken),
    /// Code was invalid
    InvalidCode,
    /// Sign-up is required (account doesn't exist)
    SignUpRequired,
}

/// Handle a client in WaitingCode state - verify the login code.
///
/// Returns a `CodeVerifyResult` indicating the next step:
/// - `Success`: Login completed, update client to Connected
/// - `PasswordRequired`: Store the token and update client to WaitingPassword
/// - `InvalidCode`: Code was wrong, let user retry
/// - `SignUpRequired`: Account doesn't exist
pub async fn handle_waiting_code(
    phone: &str,
    code: &str,
    token: &ClonableLoginToken,
    tg_client: &TelegramClient,
) -> Result<CodeVerifyResult> {
    match tg_client.sign_in(token, code).await {
        Ok(SignInResult::Success { user_id }) => {
            println!("Client {} signed in successfully (user_id: {})", phone, user_id);
            Ok(CodeVerifyResult::Success)
        }
        Ok(SignInResult::PasswordRequired(password_token)) => {
            println!("Client {} requires 2FA password", phone);
            Ok(CodeVerifyResult::PasswordRequired(*password_token))
        }
        Ok(SignInResult::InvalidCode) => {
            eprintln!("Invalid code for client {}", phone);
            Ok(CodeVerifyResult::InvalidCode)
        }
        Ok(SignInResult::SignUpRequired) => {
            eprintln!("Sign up required for client {}", phone);
            Ok(CodeVerifyResult::SignUpRequired)
        }
        Err(e) => {
            eprintln!("Failed to sign in: {}", e);
            Err(Error::msg(format!("Failed to sign in({}): {}", phone, e)))
        }
    }
}

/// Result of password verification.
pub enum PasswordVerifyResult {
    /// Password was correct, login succeeded
    Success,
    /// Password was invalid
    InvalidPassword,
}

/// Handle a client in WaitingPassword state - verify 2FA password.
pub async fn handle_waiting_password(
    phone: &str,
    password: &str,
    token: ClonablePasswordToken,
    tg_client: &TelegramClient,
) -> Result<PasswordVerifyResult> {
    match tg_client.check_password(token, password).await {
        Ok(CheckPasswordResult::Success { user_id }) => {
            println!(
                "Client {} password verified, connected (user_id: {})",
                phone, user_id
            );
            Ok(PasswordVerifyResult::Success)
        }
        Ok(CheckPasswordResult::InvalidPassword) => {
            eprintln!("Invalid password for client {}", phone);
            Ok(PasswordVerifyResult::InvalidPassword)
        }
        Err(e) => {
            eprintln!("Failed to check password: {}", e);
            Err(Error::msg(format!(
                "Failed to check password({}): {}",
                phone, e
            )))
        }
    }
}

/// Result of QR code login polling.
pub enum QrPollResult {
    /// New QR token URL to display
    Token { url: String, expires: i32 },
    /// Login succeeded
    Success,
    /// Error occurred
    Error(String),
}

/// Poll for QR code login status.
///
/// This function should be called repeatedly. It will return:
/// - `Token`: A new QR code URL to display
/// - `Success`: Login completed successfully
/// - `Error`: An error occurred
///
/// Note: The stream-based `login_with_qr` is the preferred method for new code.
/// This function is provided for simpler polling-based usage.
pub async fn poll_qr_login(api_id: i32, tg_client: &TelegramClient) -> QrPollResult {
    use futures::StreamExt;

    let mut stream = std::pin::pin!(tg_client.login_with_qr(api_id));

    // Get the next item from the stream
    match stream.next().await {
        Some(Ok(QrLoginToken::Token { url, expires })) => QrPollResult::Token { url, expires },
        Some(Ok(QrLoginToken::Success)) => QrPollResult::Success,
        Some(Ok(QrLoginToken::MigrateTo { dc_id })) => {
            // DC migration is handled internally, but we report it
            eprintln!("QR login: DC migration to {} in progress", dc_id);
            QrPollResult::Error(format!("DC migration to {} - retry", dc_id))
        }
        Some(Err(e)) => QrPollResult::Error(e.to_string()),
        None => QrPollResult::Error("QR login stream ended unexpectedly".to_string()),
    }
}
