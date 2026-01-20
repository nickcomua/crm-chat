//! SpacetimeDB client event handling.

use crate::auth::{handle_waiting_code, handle_waiting_password, handle_waiting_phone};
use crate::config::{TelegramConfig, get_session_path};
use crate::elasticsearch::ElasticsearchClient;
use crate::session::{Session, TelegramSubscriberHandler};
use crate::subscriber::telegram_subscriber;
use messanger_interface::session::JsonSessionStore;
use messanger_interface::{AuthConfig, MessengerClient, MessengerClientBuilder};
use messanger_telegram::TelegramClientBuilder;
use sdb_api::module_bindings::{
    Client as DbClient, ClientKind, ClientStatus, DbConnection, upsert_client,
};
use serde_json::json;
use spacetimedb_sdk::DbContext;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

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
            if let Ok(token) =
                handle_waiting_phone(&client.external_id, &session.telegram_client).await
            {
                session.login_token = Some(token);
                conn.reducers()
                    .upsert_client(DbClient {
                        status: ClientStatus::WaitingCode(None),
                        ..client.clone()
                    })
                    .expect("Failed to update client");
            } else {
                eprintln!("Error handling waiting phone for client {}", client.id);
                conn.reducers()
                    .upsert_client(DbClient {
                        status: ClientStatus::WaitingPhone(None),
                        ..client.clone()
                    })
                    .expect("Failed to update client");
            }
        }
        ClientStatus::WaitingCode(Some(code)) => {
            println!(
                "Client {}({}) verifying code",
                client.id, client.external_id
            );
            if let Some(token) = &session.login_token {
                if let Ok(password_token) =
                    handle_waiting_code(&client.external_id, code, token, &session.telegram_client)
                        .await
                {
                    session.password_token = password_token;
                    if session.password_token.is_some() {
                        println!("Client {} requires password, updating status", client.id);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::WaitingPassword(None),
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    } else {
                        println!("Client {} connected successfully", client.id);
                        conn.reducers()
                            .upsert_client(DbClient {
                                status: ClientStatus::Connected,
                                ..client.clone()
                            })
                            .expect("Failed to update client");
                    }
                } else {
                    eprintln!("Error handling waiting phone for client {}", client.id);
                    conn.reducers()
                        .upsert_client(DbClient {
                            status: ClientStatus::WaitingPhone(None),
                            ..client.clone()
                        })
                        .expect("Failed to update client");
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
            let Session {
                telegram_client,
                password_token,
                ..
            } = session;
            if let Some(password_token) = password_token {
                if handle_waiting_password(
                    &client.external_id,
                    password,
                    password_token,
                    &telegram_client,
                )
                .await
                .is_ok()
                {
                    println!("Client {} connected successfully", client.id);
                    conn.reducers()
                        .upsert_client(DbClient {
                            status: ClientStatus::Connected,
                            ..client.clone()
                        })
                        .expect("Failed to update client");
                } else {
                    eprintln!("Error handling waiting password for client {}", client.id);
                    conn.reducers()
                        .upsert_client(DbClient {
                            status: ClientStatus::WaitingPhone(None),
                            ..client.clone()
                        })
                        .expect("Failed to update client");
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
            session = Session {
                telegram_client,
                login_token: None,
                password_token: None,
                subscriber_handler: None,
            };
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
