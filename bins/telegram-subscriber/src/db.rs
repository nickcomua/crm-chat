//! SpacetimeDB client event handling.

use crate::auth::{
    handle_waiting_code, handle_waiting_password, handle_waiting_phone, poll_qr_login,
    CodeVerifyResult, PasswordVerifyResult, QrPollResult,
};
use crate::config::{get_session_path, TelegramConfig};
use crate::elasticsearch::ElasticsearchClient;
use crate::session::{QrPollingHandler, Session, TelegramSubscriberHandler};
use crate::subscriber::telegram_subscriber;
use messanger_interface::session::JsonSessionStore;
use messanger_interface::{AuthConfig, MessengerClient, MessengerClientBuilder};
use messanger_telegram::TelegramClient;
use messanger_telegram::TelegramClientBuilder;
use sdb_api::module_bindings::{
    upsert_client, Client as DbClient, ClientKind, ClientStatus, DbConnection,
};
use serde_json::json;
use spacetimedb_sdk::DbContext;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Background task that polls for QR login completion
async fn qr_polling_task(
    conn: Arc<DbConnection>,
    client: DbClient,
    tg_client: Arc<TelegramClient>,
    api_id: i32,
    cancel: CancellationToken,
) {
    let poll_interval = std::time::Duration::from_secs(2);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                println!("QR polling cancelled for client {}", client.id);
                return;
            }
            _ = tokio::time::sleep(poll_interval) => {
                println!("Polling QR status for client {}...", client.id);
                match poll_qr_login(api_id, &tg_client).await {
                    QrPollResult::Token { url, expires: _ } => {
                        // Token refreshed, update URL for frontend
                        println!("QR token refreshed for client {}", client.id);
                        if let Err(e) = conn.reducers().upsert_client(DbClient {
                            status: ClientStatus::WaitingQrCode(Some(url)),
                            ..client.clone()
                        }) {
                            eprintln!("Failed to update QR URL for client {}: {:?}", client.id, e);
                        }
                    }
                    QrPollResult::Success => {
                        println!("QR scan successful for client {}!", client.id);
                        // Get phone from the client if possible
                        let phone = tg_client
                            .get_client_external_id()
                            .await
                            .ok()
                            .map(|id| id.replace("telegram:", "+"));

                        // Update client to Connected status
                        let updated_client = if let Some(ref phone) = phone {
                            DbClient {
                                status: ClientStatus::Connected,
                                external_id: phone.clone(),
                                ..client.clone()
                            }
                        } else {
                            DbClient {
                                status: ClientStatus::Connected,
                                ..client.clone()
                            }
                        };
                        if let Err(e) = conn.reducers().upsert_client(updated_client) {
                            eprintln!("Failed to update client {} to Connected: {:?}", client.id, e);
                        }
                        return;
                    }
                    QrPollResult::Error(e) => {
                        eprintln!("Error polling QR status for client {}: {}", client.id, e);
                        // Continue polling
                    }
                }
            }
        }
    }
}

/// Event types for client table changes.
#[derive(Debug, Clone)]
pub enum ClientEvent {
    Insert(DbClient),
    Update { _old: DbClient, new: DbClient },
}

impl ClientEvent {
    /// Get the current client from the event.
    pub fn client(&self) -> &DbClient {
        match self {
            ClientEvent::Insert(c) => c,
            ClientEvent::Update { new, .. } => new,
        }
    }
}

/// Process a client event based on its current status.
pub async fn process_client(
    conn: Arc<DbConnection>,
    client: &DbClient,
    sessions: Arc<Mutex<HashMap<u64, Option<Session>>>>,
    config: &TelegramConfig,
    es_client: Arc<ElasticsearchClient>,
) {
    // Only process Telegram clients
    if !matches!(client.kind, ClientKind::Telegram) {
        return;
    }

    enum SessionSlot {
        Ready(Box<Session>),
        InUse,
        BuildNew,
    }

    let slot = {
        let mut sessions_guard = sessions.lock().await;
        let slot = match sessions_guard.remove(&client.id) {
            Some(Some(session)) => SessionSlot::Ready(Box::new(session)),
            Some(None) => SessionSlot::InUse,
            None => SessionSlot::BuildNew,
        };
        // Reserve / mark in-use while we work.
        sessions_guard.insert(client.id, None);
        slot
    };

    let session = match slot {
        SessionSlot::Ready(session) => Some(*session),
        SessionSlot::InUse => None,
        SessionSlot::BuildNew => {
            let tg_client_result = TelegramClientBuilder
                .build(
                    AuthConfig {
                        credentials: json!({
                            "api_id": config.api_id,
                            "api_hash": config.api_hash,
                        }),
                    },
                    Some(Box::new(JsonSessionStore::new(json!({
                        "session_file": get_session_path(&client.external_id, &client.owner_user_id.to_string()),
                    })))),
                )
                .await;

            match tg_client_result {
                Ok(tg_client) => Some(Session {
                    telegram_client: Arc::new(tg_client),
                    login_token: None,
                    password_token: None,
                    subscriber_handler: None,
                    qr_polling_handler: None,
                }),
                Err(e) => {
                    eprintln!(
                        "Failed to build Telegram client for client {}: {:?}",
                        client.id, e
                    );
                    if let Err(update_err) = conn.reducers().upsert_client(DbClient {
                        status: ClientStatus::WaitingPhone(None),
                        ..client.clone()
                    }) {
                        eprintln!(
                            "Failed to update client {} status after build failure: {:?}",
                            client.id, update_err
                        );
                    }
                    let mut sessions_guard = sessions.lock().await;
                    sessions_guard.remove(&client.id);
                    return;
                }
            }
        }
    };

    // If session is in-use, retry with exponential backoff
    let mut session = if let Some(s) = session {
        s
    } else {
        let mut retry_delay = std::time::Duration::from_millis(100);
        let max_retries = 5;
        let mut retries = 0;

        loop {
            retries += 1;
            if retries > max_retries {
                eprintln!(
                    "Session for client {} still in use after {} retries, giving up",
                    client.id, max_retries
                );
                return;
            }

            eprintln!(
                "Session for client {} is in use, retrying in {:?} (attempt {}/{})",
                client.id, retry_delay, retries, max_retries
            );
            tokio::time::sleep(retry_delay).await;
            retry_delay = std::cmp::min(retry_delay * 2, std::time::Duration::from_secs(5));

            let mut sessions_guard = sessions.lock().await;
            if let Some(Some(s)) = sessions_guard.remove(&client.id) {
                sessions_guard.insert(client.id, None);
                break s;
            }
            // Preserve the in-use marker while we retry
            sessions_guard.insert(client.id, None);
            drop(sessions_guard);
        }
    };
    match &client.status {
        ClientStatus::WaitingPhone(Some(phone)) => {
            println!(
                "Client {} requesting login code for phone: {}",
                client.id, phone
            );
            if session
                .telegram_client
                .is_authorized()
                .await
                .is_ok_and(|r| r)
            {
                println!(
                    "Client {}({}) is already connected, skipping handle_waiting_phone",
                    client.id, client.external_id
                );
                conn.reducers()
                    .upsert_client(DbClient {
                        status: ClientStatus::Connected,
                        ..client.clone()
                    })
                    .expect("Failed to update client");
                let mut sessions_guard = sessions.lock().await;
                sessions_guard.insert(client.id, Some(session));
                return;
            }
            match handle_waiting_phone(&client.external_id, &session.telegram_client).await {
                Ok(token) => {
                    session.login_token = Some(token);
                    conn.reducers()
                        .upsert_client(DbClient {
                            status: ClientStatus::WaitingCode(None),
                            ..client.clone()
                        })
                        .expect("Failed to update client");
                }
                Err(e) => {
                    eprintln!(
                        "Error handling waiting phone for client {}: {}",
                        client.id, e
                    );
                    conn.reducers()
                        .upsert_client(DbClient {
                            status: ClientStatus::WaitingPhone(None),
                            ..client.clone()
                        })
                        .expect("Failed to update client");
                }
            }
        }
        ClientStatus::WaitingQrCode(None) => {
            // Initial QR code request - generate and return the QR URL
            println!(
                "Client {}({}) requesting QR code login",
                client.id, client.external_id
            );

            // Cancel any existing QR polling handler
            if let Some(handler) = session.qr_polling_handler.take() {
                handler.cancel.cancel();
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(2), handler.handler).await;
            }

            match poll_qr_login(config.api_id, &session.telegram_client).await {
                QrPollResult::Token { url, expires: _ } => {
                    println!("Client {} QR code generated, starting polling", client.id);
                    conn.reducers()
                        .upsert_client(DbClient {
                            status: ClientStatus::WaitingQrCode(Some(url)),
                            ..client.clone()
                        })
                        .expect("Failed to update client with QR URL");

                    // Start QR polling task
                    let cancel = CancellationToken::new();
                    let handler = tokio::spawn(qr_polling_task(
                        conn.clone(),
                        client.clone(),
                        session.telegram_client.clone(),
                        config.api_id,
                        cancel.clone(),
                    ));
                    session.qr_polling_handler = Some(QrPollingHandler { handler, cancel });
                }
                QrPollResult::Success => {
                    println!("Client {} already authorized via QR", client.id);
                    // Get phone from the client if possible
                    let phone = session
                        .telegram_client
                        .get_client_external_id()
                        .await
                        .ok()
                        .map(|id| id.replace("telegram:", "+"));

                    let updated_client = if let Some(phone) = phone {
                        DbClient {
                            status: ClientStatus::Connected,
                            external_id: phone,
                            ..client.clone()
                        }
                    } else {
                        DbClient {
                            status: ClientStatus::Connected,
                            ..client.clone()
                        }
                    };
                    conn.reducers()
                        .upsert_client(updated_client)
                        .expect("Failed to update client");
                }
                QrPollResult::Error(e) => {
                    eprintln!("Error generating QR code for client {}: {}", client.id, e);
                    // Keep waiting for QR - client can retry
                }
            }
        }
        ClientStatus::WaitingQrCode(Some(_url)) => {
            // QR code is displayed, polling is handled by the background task
            // If we get here, the polling task should already be running
            // Just ensure it's running, otherwise restart it
            if session.qr_polling_handler.is_none() {
                println!(
                    "Client {}({}) has QR URL but no polling task, restarting polling",
                    client.id, client.external_id
                );
                let cancel = CancellationToken::new();
                let handler = tokio::spawn(qr_polling_task(
                    conn.clone(),
                    client.clone(),
                    session.telegram_client.clone(),
                    config.api_id,
                    cancel.clone(),
                ));
                session.qr_polling_handler = Some(QrPollingHandler { handler, cancel });
            } else {
                println!(
                    "Client {}({}) QR polling already active",
                    client.id, client.external_id
                );
            }
        }
        ClientStatus::WaitingCode(Some(code)) => {
            println!(
                "Client {}({}) verifying code",
                client.id, client.external_id
            );
            if let Some(token) = &session.login_token {
                match handle_waiting_code(
                    &client.external_id,
                    code,
                    token,
                    &session.telegram_client,
                )
                .await
                {
                    Ok(CodeVerifyResult::Success) => {
                        println!("Client {} connected successfully", client.id);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::Connected,
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                    Ok(CodeVerifyResult::PasswordRequired(password_token)) => {
                        println!("Client {} requires password, updating status", client.id);
                        session.password_token = Some(password_token);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::WaitingPassword(None),
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                    Ok(CodeVerifyResult::InvalidCode) => {
                        eprintln!("Invalid code for client {}, letting user retry", client.id);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::WaitingCode(None),
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                    Ok(CodeVerifyResult::SignUpRequired) => {
                        eprintln!(
                            "Sign up required for client {}, account doesn't exist",
                            client.id
                        );
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::WaitingPhone(None),
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                    Err(e) => {
                        eprintln!("Error handling code for client {}: {}", client.id, e);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::WaitingPhone(None),
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                }
            } else {
                eprintln!("Need login token for client {}", client.id);
                conn.reducers()
                    .upsert_client(DbClient {
                        status: ClientStatus::WaitingPhone(None),
                        ..client.clone()
                    })
                    .expect("Failed to update client");
            }
        }
        ClientStatus::WaitingPassword(Some(password)) => {
            println!(
                "Client {}({}) verifying password",
                client.id, client.external_id
            );
            // Cancel any existing subscriber handler before rebuilding session
            if let Some(handler) = session.subscriber_handler.take() {
                handler.cancel.cancel();
                // Wait for the task to complete (with timeout to avoid blocking indefinitely)
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(5), handler.handler).await;
            }

            if let Some(password_token) = session.password_token.take() {
                match handle_waiting_password(
                    &client.external_id,
                    password,
                    password_token,
                    &session.telegram_client,
                )
                .await
                {
                    Ok(PasswordVerifyResult::Success) => {
                        println!("Client {} connected successfully", client.id);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::Connected,
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                    Ok(PasswordVerifyResult::InvalidPassword) => {
                        eprintln!(
                            "Invalid password for client {}, letting user retry",
                            client.id
                        );
                        // Need to re-request password token since we consumed it
                        // For now, reset to phone stage
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::WaitingPhone(None),
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                    Err(e) => {
                        eprintln!("Error handling password for client {}: {}", client.id, e);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::WaitingPhone(None),
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                }
            } else {
                eprintln!("Need password token for client {}", client.id);
                conn.reducers()
                    .upsert_client(DbClient {
                        status: ClientStatus::WaitingPhone(None),
                        ..client.clone()
                    })
                    .expect("Failed to update client");
            }

            // Clear tokens after password attempt
            session.login_token = None;
        }
        ClientStatus::WaitingPhone(None) => {
            println!(
                "Client {}({}) waiting for phone input",
                client.id, client.external_id
            );
        }
        ClientStatus::WaitingCode(None) => {
            println!(
                "Client {}({}) waiting for code input",
                client.id, client.external_id
            );
        }
        ClientStatus::WaitingPassword(None) => {
            println!(
                "Client {}({}) waiting for password input",
                client.id, client.external_id
            );
        }
        ClientStatus::Connected => {
            println!("Client {}({}) is connected", client.id, client.external_id);

            // Cancel QR polling if running (no longer needed)
            if let Some(handler) = session.qr_polling_handler.take() {
                handler.cancel.cancel();
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(2), handler.handler).await;
            }

            let is_authorized = session.telegram_client.is_authorized().await;
            if !is_authorized.is_ok_and(|r| r) {
                eprintln!(
                    "Client {} is not authorized, resetting to WaitingPhone",
                    client.id
                );
                // Cancel any existing subscriber handler before resetting
                if let Some(handler) = session.subscriber_handler.take() {
                    handler.cancel.cancel();
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_secs(5), handler.handler)
                            .await;
                }
                conn.reducers()
                    .upsert_client(DbClient {
                        status: ClientStatus::WaitingPhone(None),
                        ..client.clone()
                    })
                    .expect("Failed to update client");
                let mut sessions_guard = sessions.lock().await;
                sessions_guard.insert(client.id, Some(session));
                return;
            }
            // Only spawn a new subscriber if one isn't already running
            if session.subscriber_handler.is_none() {
                let cancel = CancellationToken::new();
                let handler = tokio::spawn(telegram_subscriber(
                    conn,
                    client.clone(),
                    session.telegram_client.clone(),
                    cancel.clone(),
                    es_client,
                ));
                session.subscriber_handler = Some(TelegramSubscriberHandler { handler, cancel });
            } else {
                println!(
                    "Client {}({}) already has an active subscriber, skipping spawn",
                    client.id, client.external_id
                );
            }
        }
    }
    let mut sessions_guard = sessions.lock().await;
    sessions_guard.insert(client.id, Some(session));
}
