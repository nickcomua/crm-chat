//! SpacetimeDB client event handling.

use crate::auth::{handle_waiting_code, handle_waiting_password, handle_waiting_phone};
use crate::config::TelegramConfig;
use crate::session::ActiveSessions;
use sdb_api::module_bindings::{Client as DbClient, ClientKind, ClientStatus, DbConnection};

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
    conn: &DbConnection,
    client: &DbClient,
    sessions: ActiveSessions,
    config: &TelegramConfig,
) {
    // Only process Telegram clients
    if !matches!(client.kind, ClientKind::Telegram) {
        return;
    }

    match &client.status {
        ClientStatus::WaitingPhone(Some(phone)) => {
            println!(
                "Client {} requesting login code for phone: {}",
                client.id, phone
            );
            handle_waiting_phone(conn, client, phone, sessions, config).await;
        }
        ClientStatus::WaitingCode(Some(code)) => {
            println!("Client {}({}) verifying code", client.id, client.external_id);
            handle_waiting_code(conn, client, code, sessions).await;
        }
        ClientStatus::WaitingPassword(Some(password)) => {
            println!(
                "Client {}({}) verifying password",
                client.id, client.external_id
            );
            handle_waiting_password(conn, client, password, sessions).await;
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
        }
    }
}
