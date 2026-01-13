//! SpacetimeDB client event handling.

use crate::auth::{handle_waiting_code, handle_waiting_password, handle_waiting_phone};
use crate::config::{TelegramConfig, get_session_path};
use crate::session::{Session, TelegramSubscriberHandler};
use crate::subscriber::{sync_dialogs, telegram_subscriber};
use messanger_interface::session::JsonSessionStore;
use messanger_interface::{AuthConfig, MessengerClient, MessengerClientBuilder};
use messanger_telegram::{TelegramClient, TelegramClientBuilder};
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
) {
    // Only process Telegram clients
    if !matches!(client.kind, ClientKind::Telegram) {
        return;
    }

    let mut sessions_guard = sessions.lock().await;
    let session = {
        if let Some(session) = sessions_guard.remove(&client.id) {
            session
        } else {
            let session = Session {
                telegram_client: Arc::new(TelegramClientBuilder
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
                    .await
                    .expect("Failed to build Telegram client")),
                login_token: None,
                password_token: None,
                subscriber_handler: None,
            };
            Some(session)
        }
    };
    sessions_guard.insert(client.id, None);
    drop(sessions_guard);

    if session.is_none() {
        eprintln!("Session for this client is beeing used {}", client.id);
        // todo implement retry or somthing or make queue(task mased db)
        return;
    }
    let mut session = session.unwrap();
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
            let cancel = CancellationToken::new();
            let handler = tokio::spawn(telegram_subscriber(
                conn,
                client.clone(),
                session.telegram_client.clone(),
                cancel.clone(),
            ));
            session.subscriber_handler = Some(TelegramSubscriberHandler { handler, cancel });
        }
    }
    let mut sessions_guard = sessions.lock().await;
    sessions_guard.insert(client.id, Some(session));
}
