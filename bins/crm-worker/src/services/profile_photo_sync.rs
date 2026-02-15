//! ProfilePhotoSync — Restate virtual object for syncing chat profile photos.
//!
//! Keyed by `client_id`. Downloads profile photos from Telegram and uploads
//! them to Convex storage.

use std::sync::Arc;

use convex_backend::{ChatsUpdatePhotoArgs, ClientsTable, ConvexApi, ConvexApiClient};
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{debug, info, warn};

use crate::client_pool::ClientPool;
use crate::error::WorkerError;
use crate::ops::convex as cx;

#[restate_sdk::object]
pub trait ProfilePhotoSync {
    async fn sync(req: Json<ClientsTable>) -> Result<(), HandlerError>;
    async fn stop() -> Result<(), HandlerError>;
}

pub struct ProfilePhotoSyncImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl ProfilePhotoSync for ProfilePhotoSyncImpl {
    async fn sync(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<ClientsTable>,
    ) -> Result<(), HandlerError> {
        let req = req.into_inner();
        info!(client_id = %req.id, "ProfilePhotoSync: starting");

        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        sync_profile_photos(&self.convex, &tg_client, &req)
            .await
            .map_err(anyhow::Error::from)?;
        Ok(())
    }

    async fn stop(&self, _ctx: ObjectContext<'_>) -> Result<(), HandlerError> {
        info!("ProfilePhotoSync: stop requested");
        Ok(())
    }
}

/// Sync profile photos for all chats of a client.
pub async fn sync_profile_photos(
    convex: &ConvexApiClient,
    tg_client: &TelegramClient,
    client: &ClientsTable,
) -> Result<(), WorkerError> {
    let chats = cx::list_worker_chats(convex, &client.id).await?;
    if chats.is_empty() {
        return Ok(());
    }

    info!(total = chats.len(), "Checking profile photos");
    let mut synced = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;

    for chat in &chats {
        let chat_external_id = chat
            .chat_id
            .strip_prefix(&format!("{}:", client.id))
            .unwrap_or(&chat.chat_id);

        let tg_photo_id = match tg_client.get_chat_photo_id(chat_external_id).await {
            Ok(Some(id)) => id,
            Ok(None) => {
                skipped += 1;
                continue;
            }
            Err(e) => {
                debug!(chat_id = %chat.chat_id, error = %e, "Failed to get photo ID");
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

        let photo_bytes = match tg_client.download_chat_photo(chat_external_id).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                skipped += 1;
                continue;
            }
            Err(e) => {
                warn!(chat_id = %chat.chat_id, error = %e, "Failed to download profile photo");
                failed += 1;
                continue;
            }
        };

        match upload_photo_to_convex(convex, &chat.chat_id, &tg_photo_id, &photo_bytes).await {
            Ok(()) => {
                synced += 1;
                debug!(chat_id = %chat.chat_id, "Profile photo synced");
            }
            Err(e) => {
                warn!(chat_id = %chat.chat_id, error = %e, "Failed to upload profile photo");
                failed += 1;
            }
        }
    }

    if synced > 0 || failed > 0 {
        info!(synced, skipped, failed, "Profile photo sync complete");
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
        .map_err(|e| WorkerError::MutationFailed(format!("Failed to upload photo: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(WorkerError::MutationFailed(format!(
            "Photo upload failed (HTTP {status}): {body}"
        )));
    }

    let upload_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("Failed to parse upload: {e}")))?;

    let storage_id = upload_result["storageId"].as_str().ok_or_else(|| {
        WorkerError::MutationFailed("Missing storageId in upload response".to_string())
    })?;

    convex
        .chats_update_photo(ChatsUpdatePhotoArgs {
            chatId: chat_id.to_string(),
            storageId: storage_id.to_string(),
            photoExternalId: photo_external_id.to_string(),
        })
        .await?;

    Ok(())
}
