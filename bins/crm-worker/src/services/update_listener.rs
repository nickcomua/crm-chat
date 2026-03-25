//! UpdateListener — Restate virtual object for real-time Telegram update processing.
//!
//! Keyed by `client_id`. Subscribes to Telegram's update stream and processes
//! new messages, edits, and deletions in real-time. Periodically refreshes
//! the set of scan-enabled chats.
//!
//! Domain-driven: reads client state from Convex. Cancellation is handled via
//! a domain watcher that subscribes to the client's phase — when it becomes
//! "Disconnected" (or the client is deleted), the listener exits.

use std::collections::HashSet;
use std::sync::Arc;

use convex_backend::{
    ClientsGetForWorkerArgs, ConvexApi, ConvexApiClient, DomainOpsMarkMessageDeletedArgs,
    DomainOpsUpsertMessageArgs,
};
use futures::StreamExt;
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::error::WorkerError;
use crate::ops::convex::{self as cx, ConvexResultExt as _, EntityRequest};
use crate::ops::domain_watcher::spawn_client_phase_watcher;
use crate::ops::media::download_and_upload_media;
use crate::ops::telegram::to_upsert_media_kind;
use crate::session_manager::{SessionManager as _, TelegramSessionManager};

use super::dialog_sync::ClientFields;

#[restate_sdk::object]
pub trait UpdateListener {
    async fn listen(req: Json<EntityRequest>) -> Result<(), HandlerError>;
}

pub struct UpdateListenerImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl UpdateListener for UpdateListenerImpl {
    async fn listen(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<EntityRequest>,
    ) -> Result<(), HandlerError> {
        let client_id = req.into_inner().entity_id;

        // Query fresh domain state
        let client = self
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: client_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get client: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Client {} not found", client_id))?;

        // Idempotency guard: only listen for Listening clients
        let phase = client.phase.as_ref().map(|p| p.to_string());
        if phase.as_deref() != Some("Listening") {
            info!(client_id, ?phase, "UpdateListener: not Listening, skipping");
            return Ok(());
        }

        let cancel_token = CancellationToken::new();
        let _watcher = spawn_client_phase_watcher(&self.convex, &client_id, cancel_token.clone());

        let fields = ClientFields {
            client_id: client_id.clone(),
            user_id: client.user_id,
            telegram_id: client.telegram_id,
        };

        info!(client_id = %fields.client_id, "UpdateListener: starting");

        let tg_client = self
            .sessions
            .get_for_telegram_id(&fields.user_id, &fields.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        run_listener(&self.convex, &tg_client, &fields, &cancel_token)
            .await
            .map_err(anyhow::Error::from)?;
        Ok(())
    }
}

async fn run_listener(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    req: &ClientFields,
    token: &CancellationToken,
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
    let mut refresh_interval = tokio::time::interval(std::time::Duration::from_secs(refresh_secs));
    refresh_interval.tick().await; // consume first immediate tick

    loop {
        tokio::select! {
            biased;

            // Cancellation via domain watcher (client disconnected/deleted)
            _ = token.cancelled() => {
                info!("UpdateListener: cancelled (client phase changed)");
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

/// Load the set of scan-enabled chat external IDs for filtering real-time updates.
async fn load_scan_enabled_chats(
    convex: &ConvexApiClient,
    req: &ClientFields,
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
    req: &ClientFields,
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
                .domain_ops_upsert_message(DomainOpsUpsertMessageArgs {
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
                    .domain_ops_mark_message_deleted(DomainOpsMarkMessageDeletedArgs {
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
