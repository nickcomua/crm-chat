//! MediaDownloader — Restate virtual object for per-file media downloads.
//!
//! Keyed by media record `_id`. Each file gets its own short-lived workflow.
//! Parallelism is controlled by `maxMediaDownloads` in the orchestrator query.

use std::sync::Arc;

use convex_backend::{
    ClientsGetForWorkerArgs, ConvexApi, ConvexApiClient, MediaGetForDownloadArgs, MediaStatus,
};
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{info, warn};

use crate::ops::convex::{self as cx, EntityRequest};
use crate::ops::media::download_and_upload;
use crate::ops::telegram::{default_mime_for_kind_str, parse_media_external_id};
use crate::session_manager::{SessionManager as _, TelegramSessionManager};

#[restate_sdk::object]
pub trait MediaDownloader {
    async fn download(req: Json<EntityRequest>) -> Result<(), HandlerError>;
}

pub struct MediaDownloaderImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl MediaDownloader for MediaDownloaderImpl {
    async fn download(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<EntityRequest>,
    ) -> Result<(), HandlerError> {
        let media_id = req.into_inner().entity_id;

        // Query fresh domain state
        let media = self
            .convex
            .query_media_get_for_download(MediaGetForDownloadArgs {
                mediaId: media_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to query media: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Media record {} not found", media_id))?;

        // Idempotency guard: only process Pending media
        if media.status != MediaStatus::Pending {
            info!(media_id, status = %media.status, "MediaDownloader: not Pending, skipping");
            return Ok(());
        }

        let kind_str = media.kind.to_string();
        info!(
            telegram_file_id = %media.telegram_file_id,
            chat_id = %media.chat_id,
            kind = %kind_str,
            "MediaDownloader: downloading file"
        );

        // Look up the client to get telegramId for session lookup
        let client = self
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: media.client_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get client: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Client {} not found", media.client_id))?;

        let tg_client = self
            .sessions
            .get_for_telegram_id(&media.user_id, &client.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        let (chat_ext_id, msg_id) = match parse_media_external_id(&media.telegram_file_id) {
            Some(parsed) => parsed,
            None => {
                let err = "Invalid media external ID format";
                warn!(telegram_file_id = %media.telegram_file_id, err);
                cx::mark_media_failed(&self.convex, &media.telegram_file_id, err).await;
                return Ok(());
            }
        };

        let content_type = media
            .mime_type
            .as_deref()
            .unwrap_or_else(|| default_mime_for_kind_str(&kind_str));

        match download_and_upload(
            &self.convex,
            &tg_client,
            &chat_ext_id,
            msg_id,
            &media.telegram_file_id,
            content_type,
            media.mime_type.as_deref(),
            media.file_name.as_deref(),
            media.width,
            media.height,
            media.duration,
            media.file_size.map(|s| s as usize),
        )
        .await
        {
            Ok(()) => {
                info!(telegram_file_id = %media.telegram_file_id, "File downloaded successfully");
            }
            Err(e) => {
                warn!(
                    telegram_file_id = %media.telegram_file_id,
                    error = %e,
                    "Failed to download file"
                );
                cx::mark_media_failed(&self.convex, &media.telegram_file_id, &e.to_string()).await;
            }
        }

        Ok(())
    }
}
