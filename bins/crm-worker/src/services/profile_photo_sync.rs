//! ProfilePhotoSync — Restate virtual object for syncing chat profile photos.
//!
//! Keyed by `client_id`. Downloads profile photos from Telegram and uploads
//! them to Convex storage. Chat metadata is passed in the task args (no query needed).

use std::sync::Arc;

use convex_backend::{
    ConvexApi, ConvexApiClient, WorkerOpsUpdateChatPhotoArgs,
    WorkerTasksTask as Task, WorkerTasksTaskProfilePhotoSyncChats,
};
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{debug, info, warn};

use crate::error::WorkerError;
use crate::session_manager::{SessionManager as _, TelegramSessionManager};
use crate::ops::convex::{run_task, worker_complete, ConvexResultExt as _, TaskPayload};

#[restate_sdk::object]
pub trait ProfilePhotoSync {
    async fn sync(req: Json<TaskPayload>) -> Result<(), HandlerError>;
}

pub struct ProfilePhotoSyncImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl ProfilePhotoSync for ProfilePhotoSyncImpl {
    async fn sync(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<TaskPayload>,
    ) -> Result<(), HandlerError> {
        let payload = req.into_inner();
        let Task::ProfilePhotoSync {
            clientId,
            userId,
            telegramId,
            chats,
        } = payload.task
        else {
            return Err(anyhow::anyhow!("Expected ProfilePhotoSync task").into());
        };

        run_task(&self.convex, &payload.task_id).await;

        info!(client_id = %clientId, "ProfilePhotoSync: starting");

        let tg_client = self
            .sessions
            .get_for_telegram_id(&userId, &telegramId)
            .await
            .map_err(anyhow::Error::from)?;

        sync_profile_photos(
            &self.convex,
            &tg_client,
            &clientId,
            &chats,
            &payload.task_id,
        )
        .await
        .map_err(anyhow::Error::from)?;

        worker_complete(&self.convex, &payload.task_id).await;
        Ok(())
    }
}

/// Sync profile photos for all chats passed in task args.
async fn sync_profile_photos(
    convex: &ConvexApiClient,
    tg_client: &TelegramClient,
    client_id: &str,
    chats: &[WorkerTasksTaskProfilePhotoSyncChats],
    task_id: &str,
) -> Result<(), WorkerError> {
    if chats.is_empty() {
        return Ok(());
    }

    info!(total = chats.len(), "Checking profile photos");
    let mut synced = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;

    for chat in chats {
        let chat_external_id = chat
            .chat_id
            .strip_prefix(&format!("{client_id}:"))
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

        match upload_photo_to_convex(convex, &chat.chat_id, &tg_photo_id, &photo_bytes, task_id)
            .await
        {
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
    task_id: &str,
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
        .worker_ops_update_chat_photo(WorkerOpsUpdateChatPhotoArgs {
            taskId: task_id.to_string(),
            chatId: chat_id.to_string(),
            storageId: storage_id.to_string(),
            photoExternalId: photo_external_id.to_string(),
        })
        .await
        .check()?;

    Ok(())
}
