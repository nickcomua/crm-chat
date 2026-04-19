//! ChatScanner — scan all messages in a single chat.
//!
//! Trigger: `chats.pendingWork` entry (produced when `scanPhase = Queued`).

use std::sync::Arc;

use async_trait::async_trait;
use convex_backend::{
    ChatsGetForWorkerArgs, ChatsWorkerCompleteScanArgs, ChatsWorkerStartScanArgs,
    ChatsWorkerUpdateSyncProgressArgs, ChatsWorkerUpdateSyncProgressScanPhase,
    ChatsWorkerUpsertChatArgs, ClientsGetForWorkerArgs, ConvexApi, ConvexApiClient,
    MediaWorkerCreatePendingMediaArgs, MessagesWorkerUpsertMessageArgs,
};
use futures::{StreamExt, stream::BoxStream};
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use tracing::{info, warn};

use crate::error::WorkerError;
use crate::job::{Job, JobCtx};
use crate::ops::convex::{self as cx, ConvexResultExt as _};
use crate::ops::telegram::{to_create_pending_kind, to_upsert_media_kind};
use crate::session_manager::SessionManager as _;

struct ChatScanRequest {
    client_id: String,
    user_id: String,
    chat_id: String,
    chat_external_id: String,
    is_pinned: bool,
    pinned_name: Option<String>,
}

pub struct ChatScannerJob;

#[async_trait]
impl Job for ChatScannerJob {
    fn name(&self) -> &'static str {
        "ChatScanner"
    }

    async fn subscribe(&self, ctx: &JobCtx) -> anyhow::Result<BoxStream<'static, Vec<String>>> {
        let sub = ctx.convex.subscribe_chats_pending_work().await?;
        Ok(sub
            .filter_map(|res| async move {
                match res {
                    Ok(items) => Some(items.into_iter().map(|i| i.key).collect()),
                    Err(e) => {
                        warn!(error = %e, "chats.pendingWork subscription error");
                        None
                    }
                }
            })
            .boxed())
    }

    async fn run_one(&self, ctx: Arc<JobCtx>, chat_doc_id: String) -> anyhow::Result<()> {
        let chat = ctx
            .convex
            .query_chats_get_for_worker(ChatsGetForWorkerArgs {
                chatId: chat_doc_id.clone(),
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("chat {chat_doc_id} not found"))?;

        let scan_phase = chat.scan_phase.as_ref().map(|p| p.to_string());
        if scan_phase.as_deref() != Some("Queued") {
            info!(?scan_phase, "not Queued — skipping");
            return Ok(());
        }

        ctx.convex
            .chats_worker_start_scan(ChatsWorkerStartScanArgs {
                chatId: chat_doc_id.clone(),
            })
            .await?;
        info!(chat_id = %chat.chat_id, "starting scan");

        let client = ctx
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: chat.client_id.clone(),
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("client {} not found", chat.client_id))?;

        let tg = ctx
            .sessions
            .get_for_telegram_id(&chat.user_id, &client.telegram_id)
            .await?;

        let chat_external_id = chat
            .chat_id
            .strip_prefix(&format!("{}:", chat.client_id))
            .unwrap_or(&chat.chat_id)
            .to_string();

        let req = ChatScanRequest {
            client_id: chat.client_id.clone(),
            user_id: chat.user_id.clone(),
            chat_id: chat.chat_id.clone(),
            chat_external_id,
            is_pinned: chat.is_pinned,
            pinned_name: chat.pinned_name,
        };

        scan_chat_messages(&ctx.convex, &tg, &req).await?;

        ctx.convex
            .chats_worker_complete_scan(ChatsWorkerCompleteScanArgs {
                chatId: chat_doc_id,
            })
            .await?;
        Ok(())
    }
}

async fn scan_chat_messages(
    convex: &ConvexApiClient,
    tg: &TelegramClient,
    req: &ChatScanRequest,
) -> Result<(), WorkerError> {
    info!(chat_id = %req.chat_id, "scanning messages");

    let total_messages = tg
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
        .warn_on_err("failed to update initial sync progress");

    let mut msg_stream = match tg.iter_messages(&req.chat_external_id).await {
        Ok(s) => s,
        Err(e) => {
            warn!(chat_id = %req.chat_id, error = %e, "failed to iterate messages");
            return Ok(());
        }
    };

    let mut msg_count = 0u32;
    let mut last_ts = 0.0f64;
    while let Some(result) = msg_stream.next().await {
        let msg = match result {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, "error reading message — skipping");
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
                replyToText: msg.reply_to_text,
                forwardedFrom: None,
                reactions: None,
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

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
            warn!(error = %e, "failed to create pending media");
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
                .warn_on_err("failed to update sync progress");
        }
    }

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

    convex
        .chats_worker_update_sync_progress(ChatsWorkerUpdateSyncProgressArgs {
            chatId: req.chat_id.clone(),
            totalMessages: None,
            syncedMessages: Some(msg_count as f64),
            scanPhase: Some(ChatsWorkerUpdateSyncProgressScanPhase::Listening),
            fullScanned: Some(true),
        })
        .await
        .warn_on_err("failed to update final sync progress");

    info!(chat_id = %req.chat_id, msg_count, "chat fully scanned");
    Ok(())
}
