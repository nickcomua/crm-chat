//! ChatScanner — Restate virtual object for scanning messages in a single chat.
//!
//! Keyed by chat `_id`. Each chat scans independently, allowing parallel
//! message scanning across chats.
//! Domain-driven: reads chat state from Convex, transitions Queued → ScanningMessages → Listening.

use std::sync::Arc;

use convex_backend::{
    ChatsGetForWorkerArgs, ChatsWorkerCompleteScanArgs, ChatsWorkerStartScanArgs,
    ChatsWorkerUpdateSyncProgressArgs, ChatsWorkerUpdateSyncProgressScanPhase,
    ChatsWorkerUpsertChatArgs, ClientsGetForWorkerArgs, ConvexApi, ConvexApiClient,
    MediaWorkerCreatePendingMediaArgs, MessagesWorkerUpsertMessageArgs,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::error::WorkerError;
use crate::ops::convex::{self as cx, ConvexResultExt as _, EntityRequest};
use crate::ops::telegram::{to_create_pending_kind, to_upsert_media_kind};
use crate::session_manager::{SessionManager as _, TelegramSessionManager};

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
    async fn scan(req: Json<EntityRequest>) -> Result<(), HandlerError>;
}

pub struct ChatScannerImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl ChatScanner for ChatScannerImpl {
    async fn scan(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<EntityRequest>,
    ) -> Result<(), HandlerError> {
        let chat_doc_id = req.into_inner().entity_id;

        // Query fresh domain state
        let chat = self
            .convex
            .query_chats_get_for_worker(ChatsGetForWorkerArgs {
                chatId: chat_doc_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get chat: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Chat {} not found", chat_doc_id))?;

        // Idempotency guard: only process Queued chats
        let scan_phase = chat.scan_phase.as_ref().map(|p| p.to_string());
        if scan_phase.as_deref() != Some("Queued") {
            info!(chat_id = %chat.chat_id, ?scan_phase, "ChatScanner: not Queued, skipping");
            return Ok(());
        }

        // Transition: Queued → ScanningMessages
        self.convex
            .chats_worker_start_scan(ChatsWorkerStartScanArgs {
                chatId: chat_doc_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to start scan: {e}"))?;

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
            .sessions
            .get_for_telegram_id(&chat.user_id, &client.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        let chat_external_id = chat
            .chat_id
            .strip_prefix(&format!("{}:", chat.client_id))
            .unwrap_or(&chat.chat_id)
            .to_string();

        let scan_req = ChatScanRequest {
            client_id: chat.client_id.clone(),
            user_id: chat.user_id.clone(),
            external_id: client.telegram_id,
            chat_id: chat.chat_id.clone(),
            chat_external_id,
            is_pinned: chat.is_pinned,
            pinned_name: chat.pinned_name,
        };

        scan_chat_messages(&self.convex, &tg_client, &scan_req)
            .await
            .map_err(anyhow::Error::from)?;

        // Transition: → fullScanned=true, scanPhase=Listening
        self.convex
            .chats_worker_complete_scan(ChatsWorkerCompleteScanArgs {
                chatId: chat_doc_id,
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to complete scan: {e}"))?;

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
        .chats_worker_update_sync_progress(ChatsWorkerUpdateSyncProgressArgs {
            chatId: req.chat_id.clone(),
            totalMessages: Some(total_messages as f64),
            syncedMessages: Some(0.0),
            scanPhase: Some(ChatsWorkerUpdateSyncProgressScanPhase::ScanningMessages),
            fullScanned: None,
        })
        .await
        .warn_on_err("Failed to update initial sync progress");

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

        let message_id_clone = message_id.clone();
        convex
            .messages_worker_upsert_message(MessagesWorkerUpsertMessageArgs {
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
                mediaExternalId: msg.media_external_id.clone(),
                mediaKind: msg
                    .media_summary
                    .as_ref()
                    .map(|s| to_upsert_media_kind(s.kind)),
                replyToMessageId: msg
                    .reply_to_message_id
                    .map(|id| format!("{}:{}", req.chat_id, id)),
                forwardedFrom: None,
                reactions: None,
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

        // Create pending media record (reconciler dispatches MediaDownloader)
        if let Some(ref summary) = msg.media_summary
            && let Some(ref media_ext_id) = msg.media_external_id
            && let Err(e) = convex
                .media_worker_create_pending_media(MediaWorkerCreatePendingMediaArgs {
                    telegramFileId: media_ext_id.clone(),
                    userId: req.user_id.clone(),
                    clientId: req.client_id.clone(),
                    chatId: req.chat_id.clone(),
                    messageId: message_id_clone,
                    kind: to_create_pending_kind(summary.kind),
                    mimeType: summary.mime_type.clone(),
                    fileName: summary.file_name.clone(),
                    fileSize: summary.file_size.map(|s| s as f64),
                    width: summary.width.map(|w| w as f64),
                    height: summary.height.map(|h| h as f64),
                    duration: summary.duration,
                })
                .await
        {
            warn!(error = %e, "Failed to create pending media record");
        }

        msg_count += 1;

        if msg_count.is_multiple_of(100) {
            convex
                .chats_worker_update_sync_progress(ChatsWorkerUpdateSyncProgressArgs {
                    chatId: req.chat_id.clone(),
                    totalMessages: None,
                    syncedMessages: Some(msg_count as f64),
                    scanPhase: None,
                    fullScanned: None,
                })
                .await
                .warn_on_err("Failed to update sync progress");
        }
    }

    // Update lastMessageTs
    if last_ts > 0.0 {
        convex
            .chats_worker_upsert_chat(ChatsWorkerUpsertChatArgs {
                chatId: req.chat_id.clone(),
                userId: req.user_id.clone(),
                clientId: req.client_id.clone(),
                chatType: cx::map_chat_type(None),
                isPinned: req.is_pinned,
                pinnedName: req.pinned_name.clone(),
                lastMessageTimestamp: last_ts,
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;
    }

    // Mark scan complete with final progress
    convex
        .chats_worker_update_sync_progress(ChatsWorkerUpdateSyncProgressArgs {
            chatId: req.chat_id.clone(),
            totalMessages: None,
            syncedMessages: Some(msg_count as f64),
            scanPhase: Some(ChatsWorkerUpdateSyncProgressScanPhase::Listening),
            fullScanned: Some(true),
        })
        .await
        .warn_on_err("Failed to update final sync progress");

    info!(chat_id = %req.chat_id, msg_count, "Chat fully scanned");
    Ok(())
}
