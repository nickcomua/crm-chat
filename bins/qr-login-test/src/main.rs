//! QR Code Login Test for Telegram
//!
//! This binary tests QR code login functionality.
//! It generates a QR code in the terminal that you can scan with an already-logged-in
//! Telegram app to authorize this client.

use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use grammers_client::{Client, SignInError};
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_tl_types as tl;
use qrcode::render::unicode;
use qrcode::QrCode;
use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;

const SESSION_FILE: &str = "qr_login_test.session";

fn get_session_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(SESSION_FILE)
}

fn render_qr_code(url: &str) {
    let code = QrCode::new(url.as_bytes()).expect("Failed to create QR code");
    let image = code
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .build();

    println!("\n{}", image);
    println!("\nScan this QR code with your Telegram app");
    println!("URL: {}\n", url);
}

async fn request_login_code_and_sign_in(
    client: &Client,
    api_hash: &str,
    phone: &str,
) -> Result<()> {
    println!("Requesting login code for phone: {}", phone);

    let token = client
        .request_login_code(phone, api_hash)
        .await
        .context("Failed to request login code")?;

    print!("Enter the code you received: ");
    io::stdout().flush()?;
    let mut code = String::new();
    io::stdin().read_line(&mut code)?;
    let code = code.trim();

    match client.sign_in(&token, code).await {
        Ok(_) => {
            println!("Successfully signed in!");
            Ok(())
        }
        Err(SignInError::PasswordRequired(password_token)) => {
            let hint = password_token.hint().unwrap_or("None");
            print!("2FA password required (hint: {}): ", hint);
            io::stdout().flush()?;
            let mut password = String::new();
            io::stdin().read_line(&mut password)?;
            let password = password.trim();

            client
                .check_password(password_token, password)
                .await
                .context("Failed to check 2FA password")?;

            println!("Successfully signed in with 2FA!");
            Ok(())
        }
        Err(e) => Err(anyhow::anyhow!("Sign in failed: {}", e)),
    }
}

async fn qr_login(client: &Client, api_id: i32, api_hash: &str) -> Result<bool> {
    println!("Starting QR code login...\n");

    let except_ids = vec![];

    loop {
        let request = tl::functions::auth::ExportLoginToken {
            api_id,
            api_hash: api_hash.to_string(),
            except_ids: except_ids.clone(),
        };

        let result = client
            .invoke(&request)
            .await
            .context("Failed to export login token")?;

        match result {
            tl::enums::auth::LoginToken::Token(token) => {
                let encoded = URL_SAFE_NO_PAD.encode(&token.token);
                let url = format!("tg://login?token={}", encoded);

                // Clear screen and render new QR code
                print!("\x1B[2J\x1B[1;1H"); // Clear screen
                render_qr_code(&url);

                let expires_in = token.expires - chrono::Utc::now().timestamp() as i32;
                println!("Token expires in {} seconds", expires_in.max(0));
                println!("Waiting for scan... (Press Ctrl+C to cancel)\n");

                // Wait before requesting a new token
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            tl::enums::auth::LoginToken::MigrateTo(migrate) => {
                println!("Need to migrate to DC {}...", migrate.dc_id);

                let import_request = tl::functions::auth::ImportLoginToken {
                    token: migrate.token,
                };

                let import_result = client
                    .invoke_in_dc(migrate.dc_id, &import_request)
                    .await
                    .context(format!(
                        "Failed to import login token to DC {}",
                        migrate.dc_id
                    ))?;

                match import_result {
                    tl::enums::auth::LoginToken::Success(success) => {
                        return handle_login_success(success);
                    }
                    _ => {
                        println!("Unexpected response after migration, retrying...");
                        continue;
                    }
                }
            }
            tl::enums::auth::LoginToken::Success(success) => {
                return handle_login_success(success);
            }
        }
    }
}

fn handle_login_success(success: tl::types::auth::LoginTokenSuccess) -> Result<bool> {
    match success.authorization {
        tl::enums::auth::Authorization::Authorization(auth) => {
            println!("\n=== QR Login Successful! ===");
            if let tl::enums::User::User(user) = auth.user {
                println!(
                    "Logged in as: {} {}",
                    user.first_name.unwrap_or_default(),
                    user.last_name.unwrap_or_default()
                );
                if let Some(username) = user.username {
                    println!("Username: @{}", username);
                }
                if let Some(phone) = user.phone {
                    println!("Phone: +{}", phone);
                }
            }
            Ok(true)
        }
        tl::enums::auth::Authorization::SignUpRequired(_) => {
            println!("Account signup required - QR login only works for existing accounts");
            Ok(false)
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {

//     let _guard = sentry::init(("", sentry::ClientOptions {
//     release: sentry::release_name!(),
//     // Capture user IPs and potentially sensitive headers when using HTTP server integrations
//     // see https://docs.sentry.io/platforms/rust/data-management/data-collected for more info
//     send_default_pii: true,
//     ..Default::default()
//   }));

//   // Sentry will capture this
//   panic!("Everything is on fire!");
    // Load .env file from project root
    let env_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".env");
    dotenv::from_path(&env_path).ok();

    let api_id: i32 = env::var("TG_ID")
        .context("TG_ID environment variable not set")?
        .parse()
        .context("TG_ID must be a valid integer")?;

    let api_hash = env::var("TG_HASH").context("TG_HASH environment variable not set")?;

    let session_path = get_session_path();
    println!("Session will be saved to: {}", session_path.display());

    // Create or open SQLite session
    let session = Arc::new(
        SqliteSession::open(&session_path).context("Failed to create/load SQLite session")?,
    );

    println!("Connecting to Telegram...");

    // Create sender pool and client
    let pool = SenderPool::new(Arc::clone(&session), api_id);
    let client = Client::new(&pool);

    // Spawn the pool runner to handle network communication
    let runner_handle = tokio::spawn(pool.runner.run());

    println!("Connected!");

    if client.is_authorized().await? {
        println!("Already authorized!");
        let me = client.get_me().await?;
        println!(
            "Logged in as: {} {}",
            me.first_name().unwrap_or(""),
            me.last_name().unwrap_or("")
        );
        if let Some(phone) = me.phone() {
            println!("Phone: +{}", phone);
        }
    } else {
        println!("\nChoose login method:");
        println!("1. QR Code (scan with another device)");
        println!("2. Phone number (+380973781241)");
        print!("Enter choice (1 or 2): ");
        io::stdout().flush()?;

        let mut choice = String::new();
        io::stdin().read_line(&mut choice)?;

        match choice.trim() {
            "1" => {
                if qr_login(&client, api_id, &api_hash).await? {
                    println!("\nSession saved to: {}", session_path.display());
                }
            }
            "2" | "" => {
                let phone = "+380973781241";
                request_login_code_and_sign_in(&client, &api_hash, phone).await?;
                println!("\nSession saved to: {}", session_path.display());
            }
            _ => {
                println!("Invalid choice, defaulting to phone login");
                let phone = "+380973781241";
                request_login_code_and_sign_in(&client, &api_hash, phone).await?;
                println!("\nSession saved to: {}", session_path.display());
            }
        }
    }

    // Clean up
    drop(client);
    runner_handle.abort();

    Ok(())
}
