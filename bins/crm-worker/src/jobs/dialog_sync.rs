//! DialogSync — sync a Telegram client's dialog list into Convex.
//!
//! Trigger: `clients.pendingWork` entry with `service = "DialogSync"`
//! (produced by `phase = NeedsSync`).
//! Work: enumerate Telegram dialogs, upsert chats, transition
//! `NeedsSync → Syncing → Listening` in Convex.

use std::sync::Arc;

use async_trait::async_trait;
use convex_backend::{
    ChatsWorkerUpsertChatArgs, ClientsGetForWorkerArgs, ClientsWorkerCompleteSyncArgs,
    ClientsWorkerStartSyncArgs, ConvexApi, ConvexApiClient, MediaWorkerCreatePendingMediaArgs,
    MediaWorkerCreatePendingMediaKind,
};
use futures::{StreamExt, stream::BoxStream};
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use tracing::{info, warn};

use crate::error::WorkerError;
use crate::job::{Job, JobCtx};
use crate::ops::convex as cx;
use crate::session_manager::SessionManager as _;

const SERVICE: &str = "DialogSync";

pub struct DialogSyncJob;

#[async_trait]
impl Job for DialogSyncJob {
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
                            .filter(|i| i.service.to_string() == SERVICE)
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

        // Idempotency/resume: process both initial and in-progress phases.
        // `clients.pendingWork` keeps Syncing clients in the set so a worker
        // restart after NeedsSync → Syncing can finish the sync instead of
        // dropping the job.
        let phase = client.phase.as_ref().map(|p| p.to_string());
        if !matches!(phase.as_deref(), Some("NeedsSync" | "Syncing")) {
            info!(?phase, "not a dialog sync phase — skipping");
            return Ok(());
        }

        ctx.convex
            .clients_worker_start_sync(ClientsWorkerStartSyncArgs {
                clientId: client_id.clone(),
            })
            .await?;
        info!("syncing dialogs");

        let tg = ctx
            .sessions
            .get_for_telegram_id(&client.user_id, &client.telegram_id)
            .await?;

        sync_dialogs(&ctx.convex, &tg, &client_id, &client.user_id).await?;

        ctx.convex
            .clients_worker_complete_sync(ClientsWorkerCompleteSyncArgs {
                clientId: client_id,
            })
            .await?;
        Ok(())
    }
}

async fn sync_dialogs(
    convex: &ConvexApiClient,
    tg: &TelegramClient,
    client_id: &str,
    user_id: &str,
) -> Result<(), WorkerError> {
    let mut stream = tg
        .iter_dialogs()
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("iter_dialogs: {e}")))?;

    let mut count = 0u32;
    while let Some(result) = stream.next().await {
        let dialog = match result {
            Ok(d) => d,
            Err(e) => {
                warn!(error = %e, "error reading dialog — skipping");
                continue;
            }
        };
        let chat_id = format!("{client_id}:{}", dialog.external_id);
        convex
            .chats_worker_upsert_chat(ChatsWorkerUpsertChatArgs {
                chatId: chat_id.clone(),
                userId: user_id.to_string(),
                clientId: client_id.to_string(),
                chatType: cx::map_chat_type(dialog.chat_type.as_deref()),
                isPinned: dialog.is_pinned,
                pinnedName: dialog.name.clone(),
                lastMessageTimestamp: 0.0,
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

        // Queue a profile-photo download if this chat has one.
        if let Some(photo_id) = &dialog.photo_id {
            let telegram_file_id = format!("profile:{}:{}", dialog.external_id, photo_id);
            if let Err(e) = convex
                .media_worker_create_pending_media(MediaWorkerCreatePendingMediaArgs {
                    telegramFileId: telegram_file_id,
                    userId: user_id.to_string(),
                    clientId: client_id.to_string(),
                    chatId: chat_id,
                    messageId: None,
                    kind: MediaWorkerCreatePendingMediaKind::Photo,
                    mimeType: Some("image/jpeg".to_string()),
                    fileName: None,
                    fileSize: None,
                    width: None,
                    height: None,
                    duration: None,
                })
                .await
            {
                warn!(error = %e, "failed to queue profile photo download");
            }
        }

        count += 1;
    }

    info!(count, "dialogs synced");
    Ok(())
}
