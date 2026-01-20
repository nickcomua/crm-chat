//! Authentication handlers for Telegram login flow.

use anyhow::{Error, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use grammers_client::client::LoginToken;
use grammers_client::{SignInError, client::PasswordToken};
use grammers_tl_types as tl;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;

/// Handle a client in WaitingPhone state - request login code from Telegram.
pub async fn handle_waiting_phone(phone: &str, tg_client: &TelegramClient) -> Result<LoginToken> {
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
        tg_client
            .client
            .lock()
            .await
            .request_login_code(phone, &tg_client.api_hash),
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
            return Err(Error::msg("Failed to request login code"));
        }
    };

    eprintln!("handle_waiting_phone: Login code sent to phone, updating status...");

    eprintln!("handle_waiting_phone: Status updated to WaitingCode(None) successfully");
    Ok(token)
}

/// Handle a client in WaitingCode state - verify the login code.
pub async fn handle_waiting_code(
    phone: &str,
    code: &str,
    token: &LoginToken,
    tg_client: &TelegramClient,
) -> Result<Option<PasswordToken>> {
    match tg_client.client.lock().await.sign_in(token, code).await {
        Ok(_user) => {
            println!("Client {} signed in successfully", phone);
            Ok(None)
        }
        Err(SignInError::PasswordRequired(password_token)) => {
            println!("Client {} requires 2FA password", phone);
            Ok(Some(password_token))
        }
        Err(e) => {
            eprintln!("Failed to sign in: {}", e);
            Err(Error::msg(format!("Failed to sign in({}): {}", phone, e)))
        }
    }
}

/// Handle a client in WaitingPassword state - verify 2FA password.
pub async fn handle_waiting_password(
    phone: &str,
    password: &str,
    token: PasswordToken,
    tg_client: &TelegramClient,
) -> Result<()> {
    match tg_client
        .client
        .lock()
        .await
        .check_password(token, password)
        .await
    {
        Ok(_user) => {
            println!("Client {} password verified, connected", phone);
            Ok(())
        }
        Err(e) => {
            eprintln!("Failed to check password: {}", e);
            // todo handle error properly
            Err(Error::msg(format!(
                "Failed to check password({}): {}",
                phone, e
            )))
        }
    }
}

/// Result of QR code export operation
pub enum QrExportResult {
    /// New QR token URL to display
    Token { url: String, expires: i32 },
    /// Login succeeded (user scanned and approved)
    Success { phone: Option<String> },
    /// 2FA password is required
    PasswordRequired(PasswordToken),
}

/// Handle QR code login - export a login token and check for success.
/// Returns the QR URL to display, or success/password-required if login completed.
pub async fn handle_qr_login(
    api_id: i32,
    tg_client: &TelegramClient,
) -> Result<QrExportResult> {
    eprintln!("handle_qr_login: Starting QR code login flow");

    // Check if already authorized
    let auth_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.is_authorized(),
    )
    .await;

    match auth_result {
        Err(_) => {
            eprintln!("handle_qr_login: Timeout connecting to Telegram!");
            return Err(Error::msg("Timeout connecting to Telegram"));
        }
        Ok(Err(e)) => {
            eprintln!("handle_qr_login: Failed to check authorization: {}", e);
            return Err(Error::msg("Failed to check authorization"));
        }
        Ok(Ok(true)) => {
            eprintln!("handle_qr_login: Already authorized!");
            // Get the phone number of the logged-in user
            let client = tg_client.client.lock().await;
            let phone = match client.get_me().await {
                Ok(me) => me.phone().map(|p| format!("+{}", p)),
                Err(_) => None,
            };
            return Ok(QrExportResult::Success { phone });
        }
        Ok(Ok(false)) => {
            eprintln!("handle_qr_login: Not authorized, exporting QR token");
        }
    }

    // Export login token
    let client = tg_client.client.lock().await;
    let request = tl::functions::auth::ExportLoginToken {
        api_id,
        api_hash: tg_client.api_hash.clone(),
        except_ids: vec![],
    };

    let result = client.invoke(&request).await.map_err(|e| {
        eprintln!("handle_qr_login: Failed to export login token: {}", e);
        Error::msg(format!("Failed to export login token: {}", e))
    })?;

    match result {
        tl::enums::auth::LoginToken::Token(token) => {
            let encoded = URL_SAFE_NO_PAD.encode(&token.token);
            let url = format!("tg://login?token={}", encoded);
            eprintln!("handle_qr_login: Generated QR token URL, expires: {}", token.expires);
            Ok(QrExportResult::Token {
                url,
                expires: token.expires,
            })
        }
        tl::enums::auth::LoginToken::MigrateTo(migrate) => {
            eprintln!("handle_qr_login: Need to migrate to DC {}", migrate.dc_id);
            // Import the token on the correct DC
            let import_request = tl::functions::auth::ImportLoginToken {
                token: migrate.token,
            };

            let import_result = client
                .invoke_in_dc(migrate.dc_id, &import_request)
                .await
                .map_err(|e| {
                    Error::msg(format!(
                        "Failed to import login token to DC {}: {}",
                        migrate.dc_id, e
                    ))
                })?;

            match import_result {
                tl::enums::auth::LoginToken::Success(success) => {
                    handle_qr_success(success, &client).await
                }
                _ => {
                    // Generate a new token for the user to scan
                    Err(Error::msg("Unexpected response after DC migration"))
                }
            }
        }
        tl::enums::auth::LoginToken::Success(success) => {
            eprintln!("handle_qr_login: Login successful!");
            handle_qr_success(success, &client).await
        }
    }
}

/// Handle successful QR login
async fn handle_qr_success(
    success: tl::types::auth::LoginTokenSuccess,
    client: &grammers_client::Client,
) -> Result<QrExportResult> {
    match success.authorization {
        tl::enums::auth::Authorization::Authorization(auth) => {
            // Get phone from the authorized user
            let phone = if let tl::enums::User::User(user) = auth.user {
                user.phone.map(|p| format!("+{}", p))
            } else {
                None
            };
            Ok(QrExportResult::Success { phone })
        }
        tl::enums::auth::Authorization::SignUpRequired(_) => {
            Err(Error::msg("Account signup required - QR login only works for existing accounts"))
        }
    }
}
