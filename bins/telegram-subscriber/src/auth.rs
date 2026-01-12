//! Authentication handlers for Telegram login flow.

use crate::config::{TelegramConfig, get_session_path};
use crate::session::{ActiveSessions, LoginSession};
use grammers_client::{Client, SignInError};
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use sdb_api::module_bindings::{Client as DbClient, ClientStatus, DbConnection, upsert_client};
use spacetimedb_sdk::DbContext;
use std::path::PathBuf;
use std::sync::Arc;

/// Create a Telegram client from a session file.
fn create_telegram_client(
    session_path: &PathBuf,
    api_id: i32,
) -> anyhow::Result<(Client, SenderPool)> {
    let session = SqliteSession::open(session_path)?;
    let pool = SenderPool::new(Arc::new(session), api_id);
    let client = Client::new(&pool);
    Ok((client, pool))
}

/// Helper to update client status in the database.
fn update_client_status(conn: &DbConnection, client: &DbClient, status: ClientStatus) {
    let updated_client = DbClient {
        id: client.id,
        owner_user_id: client.owner_user_id,
        kind: client.kind,
        external_id: client.external_id.clone(),
        active_chats: client.active_chats.clone(),
        status,
        session: client.session.clone(),
    };

    if let Err(e) = conn.reducers().upsert_client(updated_client) {
        eprintln!("Failed to update client status: {}", e);
    }
}

/// Helper to update client with new session path.
fn update_client_with_session(
    conn: &DbConnection,
    client: &DbClient,
    status: ClientStatus,
    session_path: &str,
) {
    let updated_client = DbClient {
        id: client.id,
        owner_user_id: client.owner_user_id,
        kind: client.kind,
        external_id: client.external_id.clone(),
        active_chats: client.active_chats.clone(),
        status,
        session: session_path.to_string(),
    };

    if let Err(e) = conn.reducers().upsert_client(updated_client) {
        eprintln!("Failed to update client status: {}", e);
    }
}

/// Restart the login flow when session is lost (e.g., after service restart).
pub async fn restart_login_flow(conn: &DbConnection, client: &DbClient) {
    eprintln!(
        "Restarting login flow for client {} (service may have restarted)",
        client.id
    );
    update_client_status(
        conn,
        client,
        ClientStatus::WaitingPhone(Some(client.external_id.clone())),
    );
}

/// Handle a client in WaitingPhone state - request login code from Telegram.
pub async fn handle_waiting_phone(
    conn: &DbConnection,
    client: &DbClient,
    phone: &str,
    sessions: ActiveSessions,
    config: &TelegramConfig,
) {
    eprintln!(
        "handle_waiting_phone: Starting for client {} with phone {}",
        client.id, phone
    );

    // Determine session path - use existing if stored, otherwise create new
    let session_path = if client.session.is_empty() {
        get_session_path(phone)
    } else {
        PathBuf::from(&client.session)
    };
    let session_path_str = session_path.to_string_lossy().to_string();
    eprintln!("handle_waiting_phone: Session path: {:?}", session_path);

    let (tg_client, pool) = match create_telegram_client(&session_path, config.api_id) {
        Ok(c) => {
            eprintln!("handle_waiting_phone: Telegram client created successfully");
            c
        }
        Err(e) => {
            eprintln!(
                "handle_waiting_phone: Failed to create Telegram client: {}",
                e
            );
            return;
        }
    };

    // Start the sender pool runner
    // TODO fix this warning
    #[allow(clippy::let_underscore_future)]
    let _ = tokio::spawn(pool.runner.run());

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
            update_client_with_session(
                conn,
                client,
                ClientStatus::WaitingPhone(None),
                &session_path_str,
            );
            return;
        }
        Ok(Err(e)) => {
            eprintln!("handle_waiting_phone: Failed to check authorization: {}", e);
            update_client_with_session(
                conn,
                client,
                ClientStatus::WaitingPhone(None),
                &session_path_str,
            );
            return;
        }
        Ok(Ok(true)) => {
            eprintln!("handle_waiting_phone: Already authorized! Updating status to Connected.");
            update_client_with_session(conn, client, ClientStatus::Connected, &session_path_str);
            return;
        }
        Ok(Ok(false)) => {
            eprintln!("handle_waiting_phone: Not authorized, will request login code");
        }
    }

    // Request login code with timeout
    eprintln!("handle_waiting_phone: Requesting login code from Telegram (timeout 30s)...");
    let code_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tg_client.request_login_code(phone, &config.api_hash),
    )
    .await;

    let token = match code_result {
        Err(_) => {
            eprintln!("handle_waiting_phone: Timeout requesting login code!");
            update_client_with_session(
                conn,
                client,
                ClientStatus::WaitingPhone(None),
                &session_path_str,
            );
            return;
        }
        Ok(Ok(t)) => {
            eprintln!("handle_waiting_phone: Login code requested successfully!");
            t
        }
        Ok(Err(e)) => {
            eprintln!("handle_waiting_phone: Failed to request login code: {}", e);
            update_client_with_session(
                conn,
                client,
                ClientStatus::WaitingPhone(None),
                &session_path_str,
            );
            return;
        }
    };

    eprintln!("handle_waiting_phone: Login code sent to phone, updating status...");

    // Store the session with the login token
    {
        let mut sessions_guard = sessions.lock().await;
        sessions_guard.insert(
            client.id,
            LoginSession::new(tg_client, token, session_path.clone()),
        );
    }

    // Update status to WaitingCode
    update_client_with_session(
        conn,
        client,
        ClientStatus::WaitingCode(None),
        &session_path_str,
    );
    eprintln!("handle_waiting_phone: Status updated to WaitingCode(None) successfully");
}

/// Handle a client in WaitingCode state - verify the login code.
pub async fn handle_waiting_code(
    conn: &DbConnection,
    client: &DbClient,
    code: &str,
    sessions: ActiveSessions,
) {
    let mut sessions_guard = sessions.lock().await;
    let (session, token) = match sessions_guard.get_mut(&client.id) {
        Some(s) => match s.token.take() {
            Some(t) => (s, t),
            None => {
                eprintln!("No login token found for client {}", client.id);
                drop(sessions_guard);
                restart_login_flow(conn, client).await;
                return;
            }
        },
        None => {
            eprintln!(
                "No active session found for client {}. Restarting login flow.",
                client.id
            );
            drop(sessions_guard);
            restart_login_flow(conn, client).await;
            return;
        }
    };

    match session.client.sign_in(&token, code).await {
        Ok(_user) => {
            println!("Client {} signed in successfully", client.id);
            drop(sessions_guard);
            update_client_status(conn, client, ClientStatus::Connected);
        }
        Err(SignInError::PasswordRequired(password_token)) => {
            println!("Client {} requires 2FA password", client.id);
            // Store the password token for later use
            session.password_token = Some(password_token);
            drop(sessions_guard);
            update_client_status(conn, client, ClientStatus::WaitingPassword(None));
        }
        Err(e) => {
            eprintln!("Failed to sign in: {}", e);
        }
    }
}

/// Handle a client in WaitingPassword state - verify 2FA password.
pub async fn handle_waiting_password(
    conn: &DbConnection,
    client: &DbClient,
    password: &str,
    sessions: ActiveSessions,
) {
    let mut sessions_guard = sessions.lock().await;

    // Check if we have an active session with a password token
    if let Some(session) = sessions_guard.get_mut(&client.id)
        && let Some(password_token) = session.password_token.take()
    {
        match session
            .client
            .check_password(password_token, password)
            .await
        {
            Ok(_user) => {
                println!("Client {} password verified, connected", client.id);
                drop(sessions_guard);
                update_client_status(conn, client, ClientStatus::Connected);
                return;
            }
            Err(e) => {
                eprintln!("Failed to check password: {}", e);
                drop(sessions_guard);
                update_client_status(conn, client, ClientStatus::WaitingPassword(None));
                return;
            }
        }
    }

    drop(sessions_guard);

    // No active session or no password token - service may have restarted
    eprintln!(
        "No active session/password token for client {}. Service may have restarted.",
        client.id
    );
    restart_login_flow(conn, client).await;
}
