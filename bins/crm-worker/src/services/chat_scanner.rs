//! ChatScanner — Restate virtual object for scanning messages in a single chat.
//!
//! Keyed by `chat_id` (e.g. "client_id:chat_external_id"). Each chat scans
//! independently, allowing parallel message scanning across chats.

use std::sync::Arc;

use convex_backend::{
    ClientsGetForWorkerArgs, ConvexApi, ConvexApiClient, WorkerOpsCreatePendingMediaArgs,
    WorkerOpsUpdateSyncProgressArgs, WorkerOpsUpdateSyncProgressScanPhase, WorkerOpsUpsertChatArgs,
    WorkerOpsUpsertMessageArgs, WorkerTasksTask as Task,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::error::WorkerError;
use crate::ops::convex::{
    self as cx, ConvexResultExt as _, TaskPayload, run_task, worker_complete,
};
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
    async fn scan(req: Json<TaskPayload>) -> Result<(), HandlerError>;
}

pub struct ChatScannerImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl ChatScanner for ChatScannerImpl {
    async fn scan(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<TaskPayload>,
    ) -> Result<(), HandlerError> {
        let payload = req.into_inner();
        let Task::ChatScanner {
            chatId,
            clientId,
            userId,
            isPinned,
            pinnedName,
        } = payload.task
        else {
            return Err(anyhow::anyhow!("Expected ChatScanner task").into());
        };

        run_task(&self.convex, &payload.task_id).await;
        info!(chat_id = %chatId, "ChatScanner: starting scan");

        // Resolve telegram_id from the client record
        let client = self
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: clientId.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get client: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Client {} not found", clientId))?;

        let tg_client = self
            .sessions
            .get_for_telegram_id(&userId, &client.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        let chat_external_id = chatId
            .strip_prefix(&format!("{}:", clientId))
            .unwrap_or(&chatId)
            .to_string();

        let scan_req = ChatScanRequest {
            client_id: clientId,
            user_id: userId,
            external_id: client.telegram_id,
            chat_id: chatId,
            chat_external_id,
            is_pinned: isPinned,
            pinned_name: pinnedName,
        };

        scan_chat_messages(&self.convex, &tg_client, &scan_req, &payload.task_id)
            .await
            .map_err(anyhow::Error::from)?;

        // Completion handler (completeChatScanner) sets fullScanned + scanPhase atomically
        worker_complete(&self.convex, &payload.task_id).await;
        Ok(())
    }
}

/// Full message scan for a single chat.
pub async fn scan_chat_messages(
    convex: &ConvexApiClient,
    tg_client: &TelegramClient,
    req: &ChatScanRequest,
    task_id: &str,
) -> Result<(), WorkerError> {
    info!(chat_id = %req.chat_id, chat_external_id = %req.chat_external_id, "Scanning messages");

    let total_messages = tg_client
        .get_messages_count(&req.chat_external_id)
        .await
        .unwrap_or(0);

    convex
        .worker_ops_update_sync_progress(WorkerOpsUpdateSyncProgressArgs {
            taskId: task_id.to_string(),
            chatId: req.chat_id.clone(),
            totalMessages: Some(total_messages as f64),
            syncedMessages: Some(0.0),
            scanPhase: Some(WorkerOpsUpdateSyncProgressScanPhase::ScanningMessages),
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
            .worker_ops_upsert_message(WorkerOpsUpsertMessageArgs {
                taskId: task_id.to_string(),
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
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

        // Create pending media record + enqueue per-file download task
        if let Some(ref summary) = msg.media_summary
            && let Some(ref media_ext_id) = msg.media_external_id
            && let Err(e) = convex
                .worker_ops_create_pending_media(WorkerOpsCreatePendingMediaArgs {
                    taskId: task_id.to_string(),
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
                .worker_ops_update_sync_progress(WorkerOpsUpdateSyncProgressArgs {
                    taskId: task_id.to_string(),
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
            .worker_ops_upsert_chat(WorkerOpsUpsertChatArgs {
                taskId: task_id.to_string(),
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
        .worker_ops_update_sync_progress(WorkerOpsUpdateSyncProgressArgs {
            taskId: task_id.to_string(),
            chatId: req.chat_id.clone(),
            totalMessages: None,
            syncedMessages: Some(msg_count as f64),
            scanPhase: Some(WorkerOpsUpdateSyncProgressScanPhase::Listening),
            fullScanned: Some(true),
        })
        .await
        .warn_on_err("Failed to update final sync progress");

    info!(chat_id = %req.chat_id, msg_count, "Chat fully scanned");
    Ok(())
}
