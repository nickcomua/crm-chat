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
    ids::{TelegramChatId, TelegramMessageId},
    subscriber::sync_dialogs,
};
pub async fn telegram_subscriber(
    conn: Arc<DbConnection>,
    client: Client,
    tg_client: Arc<TelegramClient>,
    cancell: CancellationToken,
) {
    let dialogs = sync_dialogs(&conn, &client, &tg_client).await;
    let mut stream = tg_client
        .iter_updates()
        .await
        .expect("Failed to get stream");
    let dialogs: HashMap<String, (sdb_api::module_bindings::Chat, TelegramChatId)> =
        HashMap::from_iter(dialogs.into_iter().map(|d| {
            let id = TelegramChatId::try_from(d.id.clone()).unwrap();
            (id.dialog_external_id.clone(), (d, id))
        }));
    while let Some(update) = select! {
        update = stream.next() => update,
        _ = cancell.cancelled() => None,
    } {
        // println!("Received update for client {}: {:?}", client.id, update);
        // println!();
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
                let dialog = dialogs.get(&msg.chat_external_id).unwrap();
                let id = TelegramMessageId {
                    client_id: dialog.1.client_id,
                    dialog_external_id: dialog.1.dialog_external_id.clone(),
                    message_external_id: msg.external_id.clone(),
                };
                conn.reducers()
                    .upsert_message(Message {
                        id: id.into(),
                        owner_user_id: client.owner_user_id,
                        external_id: msg.external_id.clone(),
                        client_id: client.id,
                        chat_id: dialog.0.id.clone(),
                        deleted: false,
                        out: msg.outgoing,
                        // media_id: message.media_external_id, @todo
                        media_id: None,
                        text: msg.text.clone(),
                        ts: msg.timestamp_ms.unwrap_or(0),
                    })
                    .expect("Failed to upsert message");
            }
            Update::MessageEdited(msg) => {
                let dialog = dialogs.get(&msg.chat_external_id).unwrap();
                let id = TelegramMessageId {
                    client_id: dialog.1.client_id,
                    dialog_external_id: dialog.1.dialog_external_id.clone(),
                    message_external_id: msg.external_id.clone(),
                };
                conn.reducers()
                    .upsert_message(Message {
                        id: id.into(),
                        owner_user_id: client.owner_user_id,
                        external_id: msg.external_id.clone(),
                        client_id: client.id,
                        chat_id: dialog.0.id.clone(),
                        deleted: false,
                        out: msg.outgoing,
                        // media_id: message.media_external_id, @todo
                        media_id: None,
                        text: msg.text.clone(),
                        ts: msg.timestamp_ms.unwrap_or(0),
                    })
                    .expect("Failed to upsert message");
            }
            Update::MessageDeleted {
                message_external_ids,
                chat_external_id: None,
            } => {
                for message_external_id in message_external_ids {
                    conn.reducers()
                        .mark_message_deleted(message_external_id)
                        .expect("Failed to mark message deleted");
                }
            }
            Update::MessageDeleted {
                message_external_ids,
                chat_external_id: Some(chat_external_id),
            } => {
                // dbg!(&message_external_ids, &chat_external_id);
                // @todo for chenals
            }
            _ => {}
        }
    }
}
