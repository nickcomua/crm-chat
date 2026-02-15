//! ChatScanner — Restate virtual object for scanning messages in a single chat.
//!
//! Keyed by `chat_id` (e.g. "client_id:chat_external_id"). Each chat scans
//! independently, allowing parallel message scanning across chats.

use std::sync::Arc;

use convex_backend::{
    ChatsMarkFullScannedArgs, ChatsTable, ChatsUpdateSyncProgressArgs,
    ChatsUpdateSyncProgressScanPhase, ChatsUpsertArgs, ClientsGetForWorkerArgs, ConvexApi,
    ConvexApiClient, MessagesUpsertArgs,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::client_pool::ClientPool;
use crate::error::WorkerError;
use crate::ops::convex as cx;
use crate::ops::telegram::to_upsert_media_kind;

/// Internal request used for direct `scan_chat_messages()` calls (e.g. from
/// UpdateListener backfill). Contains the derived fields that the Restate
/// handler resolves from `ChatsTable` + a Convex lookup.
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatScanRequest {
    pub client_id: String,
    pub user_id: String,
    pub external_id: String,
    pub chat_id: String,
    pub chat_external_id: String,
    pub is_pinned: bool,
    pub pinned_name: Option<String>,
}

#[restate_sdk::object]
pub trait ChatScanner {
    async fn scan(req: Json<ChatsTable>) -> Result<(), HandlerError>;
}

pub struct ChatScannerImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl ChatScanner for ChatScannerImpl {
    async fn scan(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<ChatsTable>,
    ) -> Result<(), HandlerError> {
        let chat = req.into_inner();
        info!(chat_id = %chat.chat_id, "ChatScanner: starting scan");

        // Resolve telegram_id from the client record
        let client = self
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: chat.client_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get client: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Client {} not found", chat.client_id))?;

        let tg_client = self
            .pool
            .get_or_create(&chat.user_id, &client.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        let chat_external_id = chat
            .chat_id
            .strip_prefix(&format!("{}:", chat.client_id))
            .unwrap_or(&chat.chat_id)
            .to_string();

        let scan_req = ChatScanRequest {
            client_id: chat.client_id,
            user_id: chat.user_id,
            external_id: client.telegram_id,
            chat_id: chat.chat_id,
            chat_external_id,
            is_pinned: chat.is_pinned,
            pinned_name: chat.pinned_name,
        };

        scan_chat_messages(&self.convex, &tg_client, &scan_req)
            .await
            .map_err(anyhow::Error::from)?;
        Ok(())
    }
}

/// Full message scan for a single chat.
pub async fn scan_chat_messages(
    convex: &ConvexApiClient,
    tg_client: &TelegramClient,
    req: &ChatScanRequest,
) -> Result<(), WorkerError> {
    info!(chat_id = %req.chat_id, chat_external_id = %req.chat_external_id, "Scanning messages");

    let total_messages = tg_client
        .get_messages_count(&req.chat_external_id)
        .await
        .unwrap_or(0);

    convex
        .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
            chatId: req.chat_id.clone(),
            totalMessages: Some(total_messages as f64),
            syncedMessages: Some(0.0),
            scanPhase: Some(ChatsUpdateSyncProgressScanPhase::ScanningMessages),
        })
        .await
        .ok();

    let mut msg_stream = match tg_client.iter_messages(&req.chat_external_id).await {
        Ok(s) => s,
        Err(e) => {
            warn!(chat_id = %req.chat_id, error = %e, "Failed to iterate messages");
            return Ok(());
        }
    };

    let mut msg_count = 0u32;
    let mut last_ts = 0.0f64;
    while let Some(result) = msg_stream.next().await {
        let msg = match result {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, "Error reading message, skipping");
                continue;
            }
        };

        let ts = msg.timestamp_ms.map(|t| t as f64).unwrap_or(0.0);
        if ts > last_ts {
            last_ts = ts;
        }

        let message_id = format!("{}:{}", req.chat_id, msg.external_id);

        convex
            .messages_upsert(MessagesUpsertArgs {
                messageId: message_id,
                externalId: msg.external_id,
                userId: req.user_id.clone(),
                clientId: req.client_id.clone(),
                chatId: req.chat_id.clone(),
                senderId: msg.sender_id,
                text: msg.text,
                outgoing: msg.outgoing,
                deleted: false,
                timestamp: ts,
                mediaExternalId: msg.media_external_id,
                mediaKind: msg
                    .media_summary
                    .as_ref()
                    .map(|s| to_upsert_media_kind(s.kind)),
            })
            .await?;

        msg_count += 1;

        if msg_count.is_multiple_of(100) {
            convex
                .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                    chatId: req.chat_id.clone(),
                    totalMessages: None,
                    syncedMessages: Some(msg_count as f64),
                    scanPhase: None,
                })
                .await
                .ok();
        }
    }

    // Update lastMessageTs
    if last_ts > 0.0 {
        convex
            .chats_upsert(ChatsUpsertArgs {
                chatId: req.chat_id.clone(),
                userId: req.user_id.clone(),
                clientId: req.client_id.clone(),
                chatType: cx::map_chat_type(None),
                isPinned: req.is_pinned,
                pinnedName: req.pinned_name.clone(),
                lastMessageTimestamp: last_ts,
            })
            .await?;
    }

    convex
        .chats_mark_full_scanned(ChatsMarkFullScannedArgs {
            chatId: req.chat_id.clone(),
        })
        .await?;

    convex
        .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
            chatId: req.chat_id.clone(),
            totalMessages: None,
            syncedMessages: Some(msg_count as f64),
            scanPhase: None,
        })
        .await
        .ok();

    info!(chat_id = %req.chat_id, msg_count, "Chat fully scanned");
    Ok(())
}
