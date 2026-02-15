//! UpdateListener — Restate virtual object for real-time Telegram update processing.
//!
//! Keyed by `client_id`. Subscribes to Telegram's update stream and processes
//! new messages, edits, and deletions in real-time. Periodically refreshes
//! scan-enabled chats and dispatches backfill work via tokio tasks.

use std::collections::HashSet;
use std::sync::Arc;

use convex_backend::{
    ChatsUpdateSyncProgressScanPhase, ConvexApi, ConvexApiClient, MessagesMarkDeletedArgs,
    MessagesUpsertArgs,
};
use futures::StreamExt;
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{debug, info, warn};

use crate::client_pool::ClientPool;
use crate::error::WorkerError;
use crate::ops::convex as cx;
use crate::ops::media::download_and_upload_media;
use crate::ops::telegram::to_upsert_media_kind;

use super::ScanRequest;
use super::chat_scanner::{ChatScanRequest, scan_chat_messages};
use super::media_downloader::download_pending_media;

#[restate_sdk::object]
pub trait UpdateListener {
    async fn listen(req: Json<ScanRequest>) -> Result<(), HandlerError>;
    async fn stop() -> Result<(), HandlerError>;
}

pub struct UpdateListenerImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl UpdateListener for UpdateListenerImpl {
    async fn listen(
        &self,
        ctx: ObjectContext<'_>,
        req: Json<ScanRequest>,
    ) -> Result<(), HandlerError> {
        let req = req.into_inner();

        // Reset cancel flag from any previous stop
        ctx.set("cancelled", false);

        info!(client_id = %req.client_id, "UpdateListener: starting");

        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.external_id)
            .await
            .map_err(anyhow::Error::from)?;

        run_listener(&self.convex, &self.pool, &ctx, &tg_client, &req)
            .await
            .map_err(anyhow::Error::from)?;
        Ok(())
    }

    async fn stop(&self, ctx: ObjectContext<'_>) -> Result<(), HandlerError> {
        info!("UpdateListener: stop requested");
        ctx.set("cancelled", true);
        Ok(())
    }
}

async fn is_cancelled(ctx: &ObjectContext<'_>) -> bool {
    ctx.get::<bool>("cancelled")
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

async fn run_listener(
    convex: &ConvexApiClient,
    pool: &Arc<ClientPool>,
    ctx: &ObjectContext<'_>,
    tg_client: &Arc<TelegramClient>,
    req: &ScanRequest,
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

    let mut backfill_handle: Option<tokio::task::JoinHandle<()>> = None;

    loop {
        // Check cancellation
        if is_cancelled(ctx).await {
            info!("Update listener cancelled");
            if let Some(h) = backfill_handle.take() {
                h.abort();
            }
            return Ok(());
        }

        tokio::select! {
            biased;

            // Periodically refresh scan-enabled chats and dispatch backfill
            _ = refresh_interval.tick() => {
                if backfill_handle.as_ref().is_some_and(|h| !h.is_finished()) {
                    debug!("Backfill still running, skipping refresh");
                    continue;
                }

                let chats_changed = match load_scan_enabled_chats(convex, req).await {
                    Ok(new_set) => {
                        let changed = new_set != scan_enabled_chats;
                        if changed {
                            info!(count = new_set.len(), "Refreshed scan-enabled chats");
                            scan_enabled_chats = new_set;
                        }
                        changed
                    }
                    Err(e) => {
                        warn!(error = %e, "Failed to refresh scan-enabled chats");
                        false
                    }
                };

                // Spawn background backfill task
                let bf_convex = convex.clone();
                let bf_pool = pool.clone();
                let bf_req = req.clone();
                backfill_handle = Some(tokio::spawn(async move {
                    if chats_changed {
                        // Scan newly-enabled chats
                        let chats = match cx::list_worker_chats(&bf_convex, &bf_req.client_id).await {
                            Ok(c) => c,
                            Err(e) => {
                                warn!(error = %e, "Failed to list chats for backfill");
                                return;
                            }
                        };
                        for chat in chats.iter().filter(|c| {
                            c.scan_enabled.unwrap_or(false) && !c.full_scanned.unwrap_or(false)
                        }) {
                            let chat_ext_id = chat
                                .chat_id
                                .strip_prefix(&format!("{}:", bf_req.client_id))
                                .unwrap_or(&chat.chat_id)
                                .to_string();

                            let tg = match bf_pool.get_or_create(&bf_req.user_id, &bf_req.external_id).await {
                                Ok(c) => c,
                                Err(e) => {
                                    warn!(error = %e, "Failed to get TG client for backfill");
                                    return;
                                }
                            };

                            let chat_req = ChatScanRequest {
                                client_id: bf_req.client_id.clone(),
                                user_id: bf_req.user_id.clone(),
                                external_id: bf_req.external_id.clone(),
                                chat_id: chat.chat_id.clone(),
                                chat_external_id: chat_ext_id,
                                is_pinned: chat.is_pinned,
                                pinned_name: chat.pinned_name.clone(),
                            };
                            if let Err(e) = scan_chat_messages(&bf_convex, &tg, &chat_req).await {
                                warn!(chat_id = %chat.chat_id, error = %e, "Backfill scan failed");
                            }
                        }
                    }

                    // Download pending media
                    let tg = match bf_pool.get_or_create(&bf_req.user_id, &bf_req.external_id).await {
                        Ok(c) => c,
                        Err(e) => {
                            warn!(error = %e, "Failed to get TG client for media backfill");
                            return;
                        }
                    };
                    if let Err(e) = download_pending_media(&bf_convex, &tg, &bf_req.client_id).await {
                        warn!(error = %e, "Failed to download pending media");
                    }

                    // Reset scanPhase back to Listening
                    cx::set_scan_phase_for_client(
                        &bf_convex,
                        &bf_req.client_id,
                        ChatsUpdateSyncProgressScanPhase::Listening,
                    )
                    .await;
                }));
            }

            update = update_stream.next() => {
                match update {
                    Some(Ok(update)) => {
                        if let Err(e) = process_update(convex, tg_client, req, &update, &scan_enabled_chats).await {
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

async fn load_scan_enabled_chats(
    convex: &ConvexApiClient,
    req: &ScanRequest,
) -> Result<HashSet<String>, WorkerError> {
    let chats = cx::list_worker_chats(convex, &req.client_id).await?;
    Ok(chats
        .iter()
        .filter(|c| c.scan_enabled.unwrap_or(false))
        .filter_map(|c| {
            c.chat_id
                .strip_prefix(&format!("{}:", req.client_id))
                .map(|s| s.to_string())
        })
        .collect())
}

async fn process_update(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    req: &ScanRequest,
    update: &Update,
    scan_enabled_chats: &HashSet<String>,
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
                .messages_upsert(MessagesUpsertArgs {
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
                .await?;

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
                tokio::spawn(async move {
                    if let Err(e) = download_and_upload_media(
                        &convex,
                        &dl_tg,
                        &dl_chat_ext,
                        &dl_msg_ext,
                        &dl_media_ext,
                        &dl_summary,
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
                    .messages_mark_deleted(MessagesMarkDeletedArgs {
                        externalId: ext_id.clone(),
                    })
                    .await
                    .ok();
            }
        }

        Update::Other { update_type, .. } => {
            debug!(update_type, "Ignoring non-message update");
        }
    }

    Ok(())
}
