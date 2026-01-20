use std::{collections::HashMap, sync::Arc};

use futures::StreamExt;
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use sdb_api::module_bindings::{
    Client, DbConnection, Message, mark_message_deleted, upsert_message,
};
use spacetimedb_sdk::DbContext;
use tokio::select;
use tokio_util::sync::CancellationToken;

use crate::{
    elasticsearch::{ElasticsearchClient, MessageDocument},
    ids::{TelegramChatId, TelegramMessageId},
    subscriber::sync_dialogs,
};

pub async fn telegram_subscriber(
    conn: Arc<DbConnection>,
    client: Client,
    tg_client: Arc<TelegramClient>,
    cancell: CancellationToken,
    es_client: Arc<ElasticsearchClient>,
) {
    let dialogs = match sync_dialogs(&conn, &client, &tg_client, es_client.clone()).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to sync dialogs for client {}: {}", client.id, e);
            return;
        }
    };

    let mut stream = match tg_client.iter_updates().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "Failed to get update stream for client {}: {:?}",
                client.id, e
            );
            return;
        }
    };

    // HashMap of dialogs - could be made mutable in the future to add new chats dynamically
    let dialogs: HashMap<String, (sdb_api::module_bindings::Chat, TelegramChatId)> =
        HashMap::from_iter(dialogs.into_iter().filter_map(|d| {
            match TelegramChatId::try_from(d.id.clone()) {
                Ok(id) => Some((id.dialog_external_id.clone(), (d, id))),
                Err(e) => {
                    eprintln!("Warning: Failed to parse chat ID {}: {:?}", d.id, e);
                    None
                }
            }
        }));

    while let Some(update) = select! {
        update = stream.next() => update,
        _ = cancell.cancelled() => None,
    } {
        if update.is_err() {
            eprintln!(
                "Error in update stream for client {}: {:?}",
                client.id,
                update.err()
            );
            continue;
        }
        let update = update.unwrap();
        match update {
            Update::NewMessage(msg) => {
                let dialog = match dialogs.get(&msg.chat_external_id) {
                    Some(d) => d,
                    None => {
                        // Unknown chat - try to sync it
                        eprintln!(
                            "Received NewMessage for unknown chat {}, attempting to sync (client {})",
                            msg.chat_external_id, client.id
                        );
                        // For now, skip - a full re-sync could be expensive
                        // TODO: Implement single-chat fetch from Telegram API
                        continue;
                    }
                };
                let id = TelegramMessageId {
                    client_id: dialog.1.client_id,
                    dialog_external_id: dialog.1.dialog_external_id.clone(),
                    message_external_id: msg.external_id.clone(),
                };
                let message_id: String = id.clone().into();
                // Convert milliseconds to seconds for consistent timestamp handling
                let ts_secs = msg.timestamp_ms.map(|ms| ms / 1000).unwrap_or(0);
                if let Err(e) = conn.reducers().upsert_message(Message {
                    id: message_id.clone(),
                    owner_user_id: client.owner_user_id,
                    external_id: msg.external_id.clone(),
                    client_id: client.id,
                    chat_id: dialog.0.id.clone(),
                    sender_id: msg.sender_id.clone(),
                    deleted: false,
                    out: msg.outgoing,
                    media_id: None,
                    text: msg.text.clone(),
                    ts: ts_secs,
                }) {
                    eprintln!(
                        "Failed to upsert message {} for client {}: {:?}",
                        msg.external_id, client.id, e
                    );
                } else if let Some(text) = &msg.text {
                    // Index to Elasticsearch on successful SpacetimeDB upsert
                    if let Err(e) = es_client
                        .index_message(MessageDocument {
                            user_id: client.owner_user_id.to_string(),
                            client_id: client.id,
                            chat_id: dialog.0.id.clone(),
                            id: message_id.clone(),
                            message_id: message_id.clone(),
                            external_id: msg.external_id.clone(),
                            sender_id: msg.sender_id.clone(),
                            content: text.clone(),
                            out: msg.outgoing,
                            created_at: ts_secs,
                        })
                        .await
                    {
                        eprintln!("Failed to index message {} to ES: {}", message_id, e);
                    }
                }
            }
            Update::MessageEdited(msg) => {
                let dialog = match dialogs.get(&msg.chat_external_id) {
                    Some(d) => d,
                    None => {
                        eprintln!(
                            "Received MessageEdited for unknown chat {}, skipping (client {})",
                            msg.chat_external_id, client.id
                        );
                        continue;
                    }
                };
                let id = TelegramMessageId {
                    client_id: dialog.1.client_id,
                    dialog_external_id: dialog.1.dialog_external_id.clone(),
                    message_external_id: msg.external_id.clone(),
                };
                let message_id: String = id.clone().into();
                // Convert milliseconds to seconds for consistent timestamp handling
                let ts_secs = msg.timestamp_ms.map(|ms| ms / 1000).unwrap_or(0);
                if let Err(e) = conn.reducers().upsert_message(Message {
                    id: message_id.clone(),
                    owner_user_id: client.owner_user_id,
                    external_id: msg.external_id.clone(),
                    client_id: client.id,
                    chat_id: dialog.0.id.clone(),
                    sender_id: msg.sender_id.clone(),
                    deleted: false,
                    out: msg.outgoing,
                    media_id: None,
                    text: msg.text.clone(),
                    ts: ts_secs,
                }) {
                    eprintln!(
                        "Failed to upsert edited message {} for client {}: {:?}",
                        msg.external_id, client.id, e
                    );
                } else if let Some(text) = &msg.text {
                    // Index to Elasticsearch on successful SpacetimeDB upsert
                    if let Err(e) = es_client
                        .index_message(MessageDocument {
                            user_id: client.owner_user_id.to_string(),
                            client_id: client.id,
                            chat_id: dialog.0.id.clone(),
                            id: message_id.clone(),
                            message_id: message_id.clone(),
                            external_id: msg.external_id.clone(),
                            sender_id: msg.sender_id.clone(),
                            content: text.clone(),
                            out: msg.outgoing,
                            created_at: ts_secs,
                        })
                        .await
                    {
                        eprintln!("Failed to index edited message {} to ES: {}", message_id, e);
                    }
                }
            }
            Update::MessageDeleted {
                message_external_ids,
                chat_external_id: None,
            } => {
                for message_external_id in message_external_ids {
                    if let Err(e) = conn
                        .reducers()
                        .mark_message_deleted(message_external_id.clone())
                    {
                        eprintln!(
                            "Failed to mark message {} deleted for client {}: {:?}",
                            message_external_id, client.id, e
                        );
                    }
                }
            }
            Update::MessageDeleted {
                message_external_ids,
                chat_external_id: Some(chat_external_id),
            } => {
                // Handle channel message deletions the same way as regular deletions
                for message_external_id in message_external_ids {
                    if let Err(e) = conn
                        .reducers()
                        .mark_message_deleted(message_external_id.clone())
                    {
                        eprintln!(
                            "Failed to mark channel message {} deleted in chat {} for client {}: {:?}",
                            message_external_id, chat_external_id, client.id, e
                        );
                    }
                }
            }
            other => {
                // eprintln!(
                //     "Unhandled update type for client {}: {:?}",
                //     client.id, other
                // );
            }
        }
    }
}
