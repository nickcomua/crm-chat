//! MediaDownloader — Restate virtual object for per-file media downloads.
//!
//! Keyed by `telegram_file_id`. Each file gets its own short-lived workflow.
//! Parallelism is controlled by `MAX_MEDIA_WORKFLOWS` in the Convex
//! `pendingForWorker` query.

use std::sync::Arc;

use convex_backend::{ConvexApiClient, WorkerTasksTask as Task};
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{info, warn};

use crate::ops::convex::{self as cx, run_task, worker_complete, TaskPayload};
use crate::ops::media::download_and_upload;
use crate::ops::telegram::{default_mime_for_kind_str, media_kind_to_str, parse_media_external_id};
use crate::session_manager::{SessionManager as _, TelegramSessionManager};

#[restate_sdk::object]
pub trait MediaDownloader {
    async fn download(req: Json<TaskPayload>) -> Result<(), HandlerError>;
}

pub struct MediaDownloaderImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl MediaDownloader for MediaDownloaderImpl {
    async fn download(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<TaskPayload>,
    ) -> Result<(), HandlerError> {
        let payload = req.into_inner();
        let Task::MediaDownloader {
            telegramFileId,
            userId,
            clientId: _,
            telegramId,
            chatId,
            kind,
            mimeType,
            fileSize,
        } = payload.task
        else {
            return Err(anyhow::anyhow!("Expected MediaDownloader task").into());
        };

        run_task(&self.convex, &payload.task_id).await;

        let kind_str = media_kind_to_str(&kind);
        info!(
            telegram_file_id = %telegramFileId,
            chat_id = %chatId,
            kind = kind_str,
            "MediaDownloader: downloading file"
        );

        let tg_client = self
            .sessions
            .get_for_telegram_id(&userId, &telegramId)
            .await
            .map_err(anyhow::Error::from)?;

        let (chat_ext_id, msg_id) = match parse_media_external_id(&telegramFileId) {
            Some(parsed) => parsed,
            None => {
                let err = "Invalid media external ID format";
                warn!(telegram_file_id = %telegramFileId, err);
                cx::mark_media_failed(&self.convex, &payload.task_id, &telegramFileId, err).await;
                worker_complete(&self.convex, &payload.task_id).await;
                return Ok(());
            }
        };

        let content_type = mimeType
            .as_deref()
            .unwrap_or_else(|| default_mime_for_kind_str(kind_str));

        match download_and_upload(
            &self.convex,
            &tg_client,
            &chat_ext_id,
            msg_id,
            &telegramFileId,
            content_type,
            mimeType.as_deref(),
            None, // fileName not in task
            None, // width
            None, // height
            None, // duration
            fileSize.map(|s| s as usize),
            &payload.task_id,
        )
        .await
        {
            Ok(()) => {
                info!(telegram_file_id = %telegramFileId, "File downloaded successfully");
            }
            Err(e) => {
                warn!(
                    telegram_file_id = %telegramFileId,
                    error = %e,
                    "Failed to download file"
                );
                cx::mark_media_failed(&self.convex, &payload.task_id, &telegramFileId, &e.to_string()).await;
            }
        }

        worker_complete(&self.convex, &payload.task_id).await;
        Ok(())
    }
}
