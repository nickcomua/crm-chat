//! Authentication handlers for Telegram login flow.

use anyhow::{Error, Result};
use grammers_client::client::LoginToken;
use grammers_client::{SignInError, client::PasswordToken};
use jsonwebtoken::TokenData;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use sdb_api::module_bindings::{Client as DbClient, ClientStatus, DbConnection};
use std::sync::Arc;

/// Handle a client in WaitingPhone state - request login code from Telegram.
pub async fn handle_waiting_phone(phone: &str, tg_client: &TelegramClient) -> Result<LoginToken> {
    eprintln!(
        "handle_waiting_phone: Starting for client {} with phone {}",
        phone, phone
    );

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
