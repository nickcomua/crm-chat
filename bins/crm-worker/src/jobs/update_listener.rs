//! UpdateListener — long-running job that processes the Telegram update
//! stream for a connected client.
//!
//! Trigger: `clients.pendingWork` entry with `service = "UpdateListener"`
//! (produced when `phase = Listening`). The runner aborts this job when
//! the client leaves the set (phase changes away from Listening or record
//! is deleted), so no in-task cancellation plumbing is needed.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use convex_backend::{
    ClientsGetForWorkerArgs, ConvexApi, ConvexApiClient, MessagesWorkerMarkMessageDeletedArgs,
    MessagesWorkerUpsertMessageArgs,
};
use futures::{StreamExt, stream::BoxStream};
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use tracing::{debug, info, warn};

use crate::error::WorkerError;
use crate::job::{Job, JobCtx};
use crate::ops::convex::{self as cx, ConvexWarnExt as _};
use crate::ops::media::download_and_upload_media;
use crate::ops::telegram::to_upsert_media_kind;
use crate::session_manager::SessionManager as _;

const SERVICE: &str = "UpdateListener";

struct ClientFields {
    client_id: String,
    user_id: String,
}

pub struct UpdateListenerJob;

#[async_trait]
impl Job for UpdateListenerJob {
    fn name(&self) -> &'static str {
        SERVICE
    }

    async fn subscribe(&self, ctx: &JobCtx) -> anyhow::Result<BoxStream<'static, Vec<String>>> {
        let sub = ctx.convex.subscribe_clients_pending_work().await?;
        Ok(sub
            .filter_map(|res| async move {
                match res {
                    Ok(items) => Some(
                        items
                            .into_iter()
                            .filter(|i| i.service == SERVICE)
                            .map(|i| i.key)
                            .collect(),
                    ),
                    Err(e) => {
                        warn!(error = %e, "clients.pendingWork subscription error");
                        None
                    }
                }
            })
            .boxed())
    }

    async fn run_one(&self, ctx: Arc<JobCtx>, client_id: String) -> anyhow::Result<()> {
        let client = ctx
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: client_id.clone(),
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("client {client_id} not found"))?;

        let phase = client.phase.as_ref().map(|p| p.to_string());
        if phase.as_deref() != Some("Listening") {
            info!(?phase, "not Listening — skipping");
            return Ok(());
        }

        let fields = ClientFields {
            client_id: client_id.clone(),
            user_id: client.user_id,
        };

        info!("starting");

        let tg = ctx
            .sessions
            .get_for_telegram_id(&fields.user_id, &client.telegram_id)
            .await?;

        run_listener(&ctx.convex, &tg, &fields).await?;
        Ok(())
    }
}

async fn run_listener(
    convex: &ConvexApiClient,
    tg: &Arc<TelegramClient>,
    req: &ClientFields,
) -> Result<(), WorkerError> {
    info!(client_id = %req.client_id, "real-time update listener running");

    let mut update_stream = tg
        .iter_updates()
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("iter_updates: {e}")))?;

    let mut scan_enabled_chats = load_scan_enabled_chats(convex, req).await?;
    let refresh_secs: u64 = crate::secrets::SecretSpec::builder()
        .with_profile("crm_worker")
        .load()
        .ok()
        .and_then(|s| s.secrets.scan_refresh_secs)
        .and_then(|v: String| v.parse().ok())
        .unwrap_or(60);
    let mut refresh = tokio::time::interval(std::time::Duration::from_secs(refresh_secs));
    refresh.tick().await;

    loop {
        tokio::select! {
            biased;

            _ = refresh.tick() => {
                match load_scan_enabled_chats(convex, req).await {
                    Ok(new_set) => {
                        if new_set != scan_enabled_chats {
                            info!(count = new_set.len(), "refreshed scan-enabled chats");
                            scan_enabled_chats = new_set;
                        }
                    }
                    Err(e) => warn!(error = %e, "failed to refresh scan-enabled chats"),
                }
            }

            update = update_stream.next() => {
                match update {
                    Some(Ok(u)) => {
                        if let Err(e) = process_update(convex, tg, req, &u, &scan_enabled_chats).await {
                            warn!(error = %e, "failed to process update");
                        }
                    }
                    Some(Err(e)) => warn!(error = %e, "error in update stream"),
                    None => {
                        info!("update stream ended");
                        return Ok(());
                    }
                }
            }
        }
    }
}

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
    tg: &Arc<TelegramClient>,
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
            let reply_to_message_id = msg
                .reply_to_message_id
                .map(|id| format!("{}:{}", chat_id, id));

            convex
                .messages_worker_upsert_message(MessagesWorkerUpsertMessageArgs {
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
                    replyToMessageId: reply_to_message_id,
                    forwardedFrom: None,
                    reactions: None,
                })
                .await
                .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

            if matches!(update, Update::NewMessage(_))
                && let Some(ref summary) = msg.media_summary
                && let Some(ref media_ext_id) = msg.media_external_id
            {
                let convex = convex.clone();
                let dl_tg = tg.clone();
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
                            "failed to download real-time media"
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
                    .messages_worker_mark_message_deleted(MessagesWorkerMarkMessageDeletedArgs {
                        externalId: ext_id.clone(),
                    })
                    .await
                    .warn_on_err("failed to mark message deleted");
            }
        }

        Update::Other { update_type, .. } => {
            debug!(update_type, "ignoring non-message update");
        }
    }
    Ok(())
}
