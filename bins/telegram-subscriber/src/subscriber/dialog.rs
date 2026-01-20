use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::elasticsearch::{ElasticsearchClient, MessageDocument};
use crate::ids::{TelegramChatId, TelegramMessageId};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use sdb_api::module_bindings::chat_type::Chat;
use sdb_api::module_bindings::message_type::Message;
use sdb_api::module_bindings::{
    ChatTableAccess, ChatType, Client, DbConnection, MessageTableAccess, upsert_chat,
    upsert_message,
};
use spacetimedb_sdk::{DbContext, Table};
use tokio::time::sleep;

/// Errors that can occur during dialog synchronization.
#[derive(Debug)]
pub enum SyncError {
    DialogFetch(String),
    DialogParse(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::DialogFetch(e) => write!(f, "Failed to fetch dialogs: {}", e),
            SyncError::DialogParse(e) => write!(f, "Failed to parse dialog: {}", e),
        }
    }
}

impl std::error::Error for SyncError {}

pub async fn sync_dialogs(
    conn: &DbConnection,
    client: &Client,
    tg_client: &TelegramClient,
    es_client: Arc<ElasticsearchClient>,
) -> Result<Vec<Chat>, SyncError> {
    let dialogs_stream = tg_client
        .iter_dialogs()
        .await
        .map_err(|e| SyncError::DialogFetch(e.to_string()))?;

    let dialogs: Vec<_> = dialogs_stream.collect().await;
    eprintln!("Fetched {} dialogs for client {}", dialogs.len(), client.id);

    let db_dialogs: Vec<Chat> = conn.db.chat().iter().collect();

    for dialog_res in dialogs {
        let dialog = dialog_res.map_err(|e| SyncError::DialogParse(e.to_string()))?;
        let id = TelegramChatId {
            client_id: client.id,
            dialog_external_id: dialog.external_id.clone(),
        };

        // Check if this chat exists and is pinned - preserve pinned status
        let existing_pinned = db_dialogs
            .iter()
            .find(|d| d.id == id.to_string())
            .map(|d| d.is_pinned)
            .unwrap_or(false);

        // Skip updating pinned chats to preserve user customizations
        if existing_pinned {
            continue;
        }

        // Get current timestamp safely
        let last_message_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_else(|_| {
                eprintln!("Warning: SystemTime before UNIX_EPOCH, using 0");
                0
            });

        if let Err(e) = conn.reducers().upsert_chat(Chat {
            id: id.into(),
            owner_user_id: client.owner_user_id,
            client_id: client.id,
            chat_type: match dialog.chat_type {
                Some(chat_type) => {
                    if chat_type == "user" {
                        ChatType::Dialog
                    } else {
                        ChatType::Group
                    }
                }
                _ => ChatType::Group,
            },
            is_pinned: false,
            pinned_name: dialog.name,
            last_message_ts,
        }) {
            eprintln!(
                "Warning: Failed to upsert chat for client {}: {:?}",
                client.id, e
            );
            // Continue with other dialogs instead of failing completely
        }
    }

    sleep(Duration::from_secs(5)).await;
    let db_dialogs: Vec<Chat> = conn.db.chat().iter().collect();
    let db_messages_ids: HashSet<String> = conn.db.message().iter().map(|m| m.id).collect();

    println!(
        "Fetched {} dialogs for client {}",
        db_dialogs.len(),
        client.id
    );
    // Collect messages for bulk ES indexing
    let mut es_docs: Vec<MessageDocument> = Vec::new();

    for dialog in db_dialogs.clone() {
        let dialog_id: TelegramChatId = match dialog.id.clone().try_into() {
            Ok(id) => id,
            Err(e) => {
                eprintln!("Warning: Failed to parse chat ID {}: {:?}", dialog.id, e);
                continue;
            }
        };

        let messages = tg_client
            .iter_messages(&dialog_id.dialog_external_id.clone())
            .await;

        if let Err(e) = messages {
            eprintln!("Failed to get messages for chat {}: {}", dialog.id, e);
            continue;
        }

        let mut messages = messages.unwrap();

        // Note: Messages are expected to be returned in reverse chronological order
        // (newest first). We break on the first message we've already seen, assuming
        // all older messages have been synced.
        while let Some(msg_res) = messages.next().await {
            let message = match msg_res {
                Ok(message) => message,
                Err(e) => {
                    eprintln!(
                        "Warning: Failed to read message for chat {}: {:?}",
                        dialog.id, e
                    );
                    continue;
                }
            };
            let id = TelegramMessageId {
                client_id: dialog_id.client_id,
                dialog_external_id: dialog_id.dialog_external_id.clone(),
                message_external_id: message.external_id.clone(),
            };
            let message_id: String = id.clone().into();

            if db_messages_ids.contains(&message_id) {
                break;
            }

            // Convert milliseconds to seconds for consistent timestamp handling
            // Log when timestamp is missing
            let ts_secs = match message.timestamp_ms {
                Some(ms) => ms / 1000,
                None => {
                    eprintln!(
                        "Warning: Message {} has no timestamp, using current time",
                        message.external_id
                    );
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                }
            };

            if let Err(e) = conn.reducers().upsert_message(Message {
                id: message_id.clone(),
                external_id: message.external_id.clone(),
                owner_user_id: client.owner_user_id,
                client_id: client.id,
                chat_id: dialog.id.clone(),
                deleted: false,
                out: message.outgoing,
                sender_id: message.sender_id.clone(),
                media_id: None,
                text: message.text.clone(),
                ts: ts_secs,
            }) {
                eprintln!(
                    "Warning: Failed to upsert message {} for client {}: {:?}",
                    message.external_id, client.id, e
                );
                // Continue with other messages instead of failing
            } else if let Some(text) = &message.text {
                // Queue for ES bulk indexing
                es_docs.push(MessageDocument {
                    user_id: client.owner_user_id.to_string(),
                    client_id: client.id,
                    chat_id: dialog.id.clone(),
                    id: message_id.clone(),
                    message_id: message_id.clone(),
                    external_id: message.external_id.clone(),
                    sender_id: message.sender_id.clone(),
                    content: text.clone(),
                    out: message.outgoing,
                    created_at: ts_secs,
                });

                // Bulk index every 100 messages to avoid memory buildup
                if es_docs.len() >= 100
                    && let Err(e) = es_client
                        .bulk_index_messages(std::mem::take(&mut es_docs))
                        .await
                {
                    eprintln!("Warning: Failed to bulk index messages to ES: {}", e);
                }
            }
        }
    }

    // Index any remaining messages
    if !es_docs.is_empty()
        && let Err(e) = es_client.bulk_index_messages(es_docs).await
    {
        eprintln!(
            "Warning: Failed to bulk index remaining messages to ES: {}",
            e
        );
    }

    Ok(db_dialogs)
}
