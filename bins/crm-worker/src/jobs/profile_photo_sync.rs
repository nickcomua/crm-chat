//! ProfilePhotoSync — download and upload chat profile photos.
//!
//! Trigger: `clients.pendingWork` entry with `service = "ProfilePhotoSync"`
//! (produced when `phase = Listening` and `photosSynced = false`).

use std::sync::Arc;

use async_trait::async_trait;
use convex_backend::{
    ChatsListChatsForWorkerArgs, ChatsTable, ChatsWorkerUpdateChatPhotoArgs,
    ClientsGetForWorkerArgs, ClientsWorkerMarkPhotosSyncedArgs, ConvexApi, ConvexApiClient,
};
use futures::{StreamExt, stream::BoxStream};
use messanger_telegram::TelegramClient;
use tracing::{debug, info, warn};

use crate::error::WorkerError;
use crate::job::{Job, JobCtx};
use crate::ops::convex::ConvexResultExt as _;
use crate::session_manager::SessionManager as _;

const SERVICE: &str = "ProfilePhotoSync";

pub struct ProfilePhotoSyncJob;

#[async_trait]
impl Job for ProfilePhotoSyncJob {
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

        if client.photos_synced != Some(false) {
            info!("photos already synced — skipping");
            return Ok(());
        }

        info!("starting");

        let tg = ctx
            .sessions
            .get_for_telegram_id(&client.user_id, &client.telegram_id)
            .await?;

        let chats = ctx
            .convex
            .query_chats_list_chats_for_worker(ChatsListChatsForWorkerArgs {
                clientId: client_id.clone(),
            })
            .await?;

        sync_profile_photos(&ctx.convex, &tg, &client_id, &chats).await?;

        ctx.convex
            .clients_worker_mark_photos_synced(ClientsWorkerMarkPhotosSyncedArgs {
                clientId: client_id,
            })
            .await?;
        Ok(())
    }
}

async fn sync_profile_photos(
    convex: &ConvexApiClient,
    tg: &TelegramClient,
    client_id: &str,
    chats: &[ChatsTable],
) -> Result<(), WorkerError> {
    if chats.is_empty() {
        return Ok(());
    }

    info!(total = chats.len(), "checking profile photos");
    let mut synced = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;

    for chat in chats {
        let chat_external_id = chat
            .chat_id
            .strip_prefix(&format!("{client_id}:"))
            .unwrap_or(&chat.chat_id);

        let tg_photo_id = match tg.get_chat_photo_id(chat_external_id).await {
            Ok(Some(id)) => id,
            Ok(None) => {
                skipped += 1;
                continue;
            }
            Err(e) => {
                debug!(chat_id = %chat.chat_id, error = %e, "failed to get photo ID");
                failed += 1;
                continue;
            }
        };

        if chat
            .photo_external_id
            .as_deref()
            .is_some_and(|stored| stored == tg_photo_id)
        {
            skipped += 1;
            continue;
        }

        let photo_bytes = match tg.download_chat_photo(chat_external_id).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                skipped += 1;
                continue;
            }
            Err(e) => {
                warn!(chat_id = %chat.chat_id, error = %e, "failed to download profile photo");
                failed += 1;
                continue;
            }
        };

        match upload_photo_to_convex(convex, &chat.chat_id, &tg_photo_id, &photo_bytes).await {
            Ok(()) => {
                synced += 1;
                debug!(chat_id = %chat.chat_id, "profile photo synced");
            }
            Err(e) => {
                warn!(chat_id = %chat.chat_id, error = %e, "failed to upload profile photo");
                failed += 1;
            }
        }
    }

    if synced > 0 || failed > 0 {
        info!(synced, skipped, failed, "profile photo sync complete");
    }
    Ok(())
}

async fn upload_photo_to_convex(
    convex: &ConvexApiClient,
    chat_id: &str,
    photo_external_id: &str,
    photo_bytes: &[u8],
) -> Result<(), WorkerError> {
    let upload_url = convex.media_generate_upload_url().await?;
    let http_client = reqwest::Client::new();
    let response = http_client
        .post(&upload_url)
        .header("Content-Type", "image/jpeg")
        .body(photo_bytes.to_vec())
        .send()
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("upload photo: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(WorkerError::MutationFailed(format!(
            "photo upload HTTP {status}: {body}"
        )));
    }

    let upload_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("parse upload: {e}")))?;

    let storage_id = upload_result["storageId"]
        .as_str()
        .ok_or_else(|| WorkerError::MutationFailed("missing storageId".into()))?;

    convex
        .chats_worker_update_chat_photo(ChatsWorkerUpdateChatPhotoArgs {
            chatId: chat_id.to_string(),
            storageId: storage_id.to_string(),
            photoExternalId: photo_external_id.to_string(),
        })
        .await
        .check()?;
    Ok(())
}
