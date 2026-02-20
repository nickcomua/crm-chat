//! UpdateListener — Restate virtual object for real-time Telegram update processing.
//!
//! Keyed by `client_id`. Subscribes to Telegram's update stream and processes
//! new messages, edits, and deletions in real-time. Periodically refreshes
//! the set of scan-enabled chats.
//!
//! Cancellation is handled via a cancel watcher that subscribes to the
//! workerTask's status — when it becomes "Cancelled", the listener exits.

use std::collections::HashSet;
use std::sync::Arc;

use convex_backend::{
    ConvexApi, ConvexApiClient, WorkerOpsMarkMessageDeletedArgs, WorkerOpsUpsertMessageArgs,
    WorkerTasksTask as Task,
};
use futures::StreamExt;
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::client_pool::ClientPool;
use crate::error::WorkerError;
use crate::ops::cancel_watcher::spawn_cancel_watcher;
use crate::ops::convex::{self as cx, run_task, worker_complete, ConvexResultExt as _, TaskPayload};
use crate::ops::media::download_and_upload_media;
use crate::ops::telegram::to_upsert_media_kind;

use super::dialog_sync::ClientTaskFields;

#[restate_sdk::object]
pub trait UpdateListener {
    async fn listen(req: Json<TaskPayload>) -> Result<(), HandlerError>;
}

pub struct UpdateListenerImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl UpdateListener for UpdateListenerImpl {
    async fn listen(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<TaskPayload>,
    ) -> Result<(), HandlerError> {
        let payload = req.into_inner();
        let Task::UpdateListener {
            clientId,
            userId,
            telegramId,
        } = payload.task
        else {
            return Err(anyhow::anyhow!("Expected UpdateListener task").into());
        };

        run_task(&self.convex, &payload.task_id).await;

        let cancel_token = CancellationToken::new();
        let _watcher = spawn_cancel_watcher(&self.convex, &payload.task_id, cancel_token.clone());

        let fields = ClientTaskFields {
            client_id: clientId,
            user_id: userId,
            telegram_id: telegramId,
        };

        info!(client_id = %fields.client_id, "UpdateListener: starting");

        let tg_client = self
            .pool
            .get_or_create(&fields.user_id, &fields.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        let result = run_listener(
            &self.convex,
            &tg_client,
            &fields,
            &cancel_token,
            &payload.task_id,
        )
        .await;
        worker_complete(&self.convex, &payload.task_id).await;
        result.map_err(anyhow::Error::from)?;
        Ok(())
    }
}

async fn run_listener(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    req: &ClientTaskFields,
    token: &CancellationToken,
    task_id: &str,
) -> Result<(), WorkerError> {
    info!(client_id = %req.client_id, "Starting real-time update listener");

    let mut update_stream = tg_client
        .iter_updates()
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("Failed to start updates: {e}")))?;

    let mut scan_enabled_chats = load_scan_enabled_chats(convex, req).await?;
    let refresh_secs: u64 = std::env::var("SCAN_REFRESH_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let mut refresh_interval =
        tokio::time::interval(std::time::Duration::from_secs(refresh_secs));
    refresh_interval.tick().await; // consume first immediate tick

    loop {
        tokio::select! {
            biased;

            // Cancellation via cancel watcher (universal cancel mechanism)
            _ = token.cancelled() => {
                info!("UpdateListener: cancelled");
                return Ok(());
            }

            // Periodically refresh scan-enabled chats
            _ = refresh_interval.tick() => {
                match load_scan_enabled_chats(convex, req).await {
                    Ok(new_set) => {
                        if new_set != scan_enabled_chats {
                            info!(count = new_set.len(), "Refreshed scan-enabled chats");
                            scan_enabled_chats = new_set;
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "Failed to refresh scan-enabled chats");
                    }
                }
            }

            update = update_stream.next() => {
                match update {
                    Some(Ok(update)) => {
                        if let Err(e) = process_update(convex, tg_client, req, &update, &scan_enabled_chats, task_id).await {
                            warn!(error = %e, "Failed to process update");
                        }
                    }
                    Some(Err(e)) => {
                        warn!(error = %e, "Error in update stream");
                    }
                    None => {
                        info!("Update stream ended");
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// Load the set of scan-enabled chat external IDs for filtering real-time updates.
async fn load_scan_enabled_chats(
    convex: &ConvexApiClient,
    req: &ClientTaskFields,
) -> Result<HashSet<String>, WorkerError> {
    let chat_ids = cx::scan_enabled_chat_ids(convex, &req.client_id).await?;
    Ok(chat_ids
        .iter()
        .filter_map(|chat_id| {
            chat_id
                .strip_prefix(&format!("{}:", req.client_id))
                .map(|s| s.to_string())
        })
        .collect())
}

async fn process_update(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    req: &ClientTaskFields,
    update: &Update,
    scan_enabled_chats: &HashSet<String>,
    task_id: &str,
) -> Result<(), WorkerError> {
    match update {
        Update::NewMessage(msg) | Update::MessageEdited(msg) => {
            if !scan_enabled_chats.contains(&msg.chat_external_id) {
                return Ok(());
            }

            let chat_id = format!("{}:{}", req.client_id, msg.chat_external_id);
            let message_id = format!("{}:{}", chat_id, msg.external_id);
            let ts = msg.timestamp_ms.map(|t| t as f64).unwrap_or(0.0);

            convex
                .worker_ops_upsert_message(WorkerOpsUpsertMessageArgs {
                    taskId: task_id.to_string(),
                    messageId: message_id,
                    externalId: msg.external_id.clone(),
                    userId: req.user_id.clone(),
                    clientId: req.client_id.clone(),
                    chatId: chat_id,
                    senderId: msg.sender_id.clone(),
                    text: msg.text.clone(),
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

            // Real-time media download in background
            if matches!(update, Update::NewMessage(_))
                && let Some(ref summary) = msg.media_summary
                && let Some(ref media_ext_id) = msg.media_external_id
            {
                let convex = convex.clone();
                let dl_tg = tg_client.clone();
                let dl_chat_ext = msg.chat_external_id.clone();
                let dl_msg_ext = msg.external_id.clone();
                let dl_media_ext = media_ext_id.clone();
                let dl_summary = summary.clone();
                let dl_task_id = task_id.to_string();
                tokio::spawn(async move {
                    if let Err(e) = download_and_upload_media(
                        &convex,
                        &dl_tg,
                        &dl_chat_ext,
                        &dl_msg_ext,
                        &dl_media_ext,
                        &dl_summary,
                        &dl_task_id,
                    )
                    .await
                    {
                        warn!(
                            media_id = %dl_media_ext,
                            error = %e,
                            "Failed to download media for real-time message"
                        );
                    }
                });
            }
        }

        Update::MessageDeleted {
            message_external_ids,
            chat_external_id,
        } => {
            if let Some(chat_ext_id) = chat_external_id
                && !scan_enabled_chats.contains(chat_ext_id)
            {
                return Ok(());
            }

            for ext_id in message_external_ids {
                convex
                    .worker_ops_mark_message_deleted(WorkerOpsMarkMessageDeletedArgs {
                        taskId: task_id.to_string(),
                        externalId: ext_id.clone(),
                    })
                    .await
                    .warn_on_err("Failed to mark message deleted");
            }
        }

        Update::Other { update_type, .. } => {
            debug!(update_type, "Ignoring non-message update");
        }
    }

    Ok(())
}
