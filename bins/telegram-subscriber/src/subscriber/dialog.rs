use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::ids::{TelegramChatId, TelegramMessageId};
use crate::session::Session;
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

pub async fn sync_dialogs(
    conn: &DbConnection,
    client: &Client,
    tg_client: &TelegramClient,
) -> Vec<Chat> {
    let dialogs = tg_client
        .iter_dialogs()
        .await
        .expect("faild to get Dialogs")
        .collect::<Vec<_>>()
        .await;
    println!("Fetched dialogs: {:?}", dialogs);

    let db_dialogs: Vec<Chat> = conn.db.chat().iter().collect();
    // dbg!(&db_dialogs);

    for dialog_res in dialogs {
        let dialog = dialog_res.expect("failed to get dialog");
        let id = TelegramChatId {
            client_id: client.id,
            dialog_external_id: dialog.external_id.clone(),
        };
        if db_dialogs
            .iter()
            .any(|d| d.id == id.to_string() && d.is_pinned)
        {
            continue;
        }
        conn.reducers()
            .upsert_chat(Chat {
                id: id.into(), // @todo create structer tu do inot and from string
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
                is_pinned: false, // todo handle pinned status
                pinned_name: dialog.name,
                last_message_ts: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs(), // todo handle last message timestamp
            })
            .expect("Failed to upsert chat");
    }
    sleep(Duration::from_secs(5)).await;
    let db_dialogs: Vec<Chat> = conn.db.chat().iter().collect();
    let db_messages_ids: HashSet<String> = conn.db.message().iter().map(|m| m.id).collect();
    for dialog in db_dialogs.clone() {
        let dialog_id: TelegramChatId = dialog.id.clone().try_into().unwrap();
        let mut messages = tg_client
            .iter_messages(&dialog_id.dialog_external_id.clone())
            .await;
        if let Err(e) = messages {
            println!("Failed to get messages: {}", e);
            continue;
        }
        let mut messages = messages.unwrap();
        while let Some(Ok(message)) = messages.next().await {
            let id = TelegramMessageId {
                client_id: dialog_id.client_id,
                dialog_external_id: dialog_id.dialog_external_id.clone(),
                message_external_id: message.external_id.clone(),
            };
            if db_messages_ids.contains(&id.to_string()) {
                break;
            }
            conn.reducers()
                .upsert_message(Message {
                    id: id.into(),
                    external_id: message.external_id.clone(),
                    owner_user_id: client.owner_user_id,
                    client_id: client.id,
                    chat_id: dialog.id.clone(),
                    deleted: false,
                    out: message.outgoing,
                    // media_id: message.media_external_id, @todo
                    media_id: None,
                    text: message.text.clone(),
                    ts: message.timestamp_ms.unwrap_or(0),
                })
                .expect("Failed to upsert message");
        }
    }
    db_dialogs
}
