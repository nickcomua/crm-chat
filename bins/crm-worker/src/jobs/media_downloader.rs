//! MediaDownloader — download a single media file from Telegram and upload it
//! to Convex storage.
//!
//! Trigger: `media.pendingWork` entry (capped client-side by `maxDownloads`).

use std::sync::Arc;

use async_trait::async_trait;
use convex_backend::{
    ChatsWorkerUpdateChatPhotoArgs, ClientsGetForWorkerArgs, ConvexApi, MediaGetForDownloadArgs,
    MediaStatus, MediaWorkerStoreMediaArgs,
};
use futures::{StreamExt, stream::BoxStream};
use tracing::{info, warn};

use crate::error::WorkerError;
use crate::job::{Job, JobCtx};
use crate::ops::convex as cx;
use crate::ops::convex::ConvexResultExt as _;
use crate::ops::media::download_and_upload;
use crate::ops::telegram::{
    default_mime_for_kind_str, parse_media_external_id, parse_profile_photo_external_id,
};
use crate::session_manager::SessionManager as _;

pub struct MediaDownloaderJob;

#[async_trait]
impl Job for MediaDownloaderJob {
    fn name(&self) -> &'static str {
        "MediaDownloader"
    }

    async fn subscribe(&self, ctx: &JobCtx) -> anyhow::Result<BoxStream<'static, Vec<String>>> {
        let max = ctx.config.max_media_workflows;
        let sub = ctx.convex.subscribe_media_pending_work().await?;
        Ok(sub
            .filter_map(move |res| async move {
                match res {
                    Ok(items) => {
                        if max > 0 {
                            Some(items.into_iter().take(max).collect())
                        } else {
                            Some(items)
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "media.pendingWork subscription error");
                        None
                    }
                }
            })
            .boxed())
    }

    async fn run_one(&self, ctx: Arc<JobCtx>, media_id: String) -> anyhow::Result<()> {
        let media = ctx
            .convex
            .query_media_get_for_download(MediaGetForDownloadArgs {
                mediaId: media_id.clone(),
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("media {media_id} not found"))?;

        if !matches!(
            media.status,
            MediaStatus::Pending | MediaStatus::Downloading
        ) {
            info!(status = %media.status, "not a downloadable status — skipping");
            return Ok(());
        }

        let kind_str = media.kind.to_string();
        info!(
            telegram_file_id = %media.telegram_file_id,
            chat_id = %media.chat_id,
            kind = %kind_str,
            "downloading file"
        );

        let client = ctx
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: media.client_id.clone(),
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("client {} not found", media.client_id))?;

        // Skip media for clients that don't have an active Telegram session.
        // This prevents the worker from incorrectly marking test media as Failed
        // in E2E environments with fake clients, and gracefully defers work for
        // real clients that haven't authenticated yet.
        if !ctx
            .sessions
            .has_canonical_session(&media.user_id, &client.telegram_id)
        {
            info!(
                client_id = %media.client_id,
                telegram_id = %client.telegram_id,
                "client has no session — skipping media download"
            );
            return Ok(());
        }

        let tg = ctx
            .sessions
            .get_for_telegram_id(&media.user_id, &client.telegram_id)
            .await?;

        if media.telegram_file_id.starts_with("profile:") {
            // Profile-photo path (replaces the old ProfilePhotoSync job).
            let (chat_ext_id, _photo_id) =
                match parse_profile_photo_external_id(&media.telegram_file_id) {
                    Some(parsed) => parsed,
                    None => {
                        let err = "invalid profile photo external ID format";
                        warn!(telegram_file_id = %media.telegram_file_id, err);
                        cx::mark_media_failed(&ctx.convex, &media.telegram_file_id, err).await;
                        return Ok(());
                    }
                };

            match download_profile_photo(
                &ctx.convex,
                &tg,
                &media.chat_id,
                &chat_ext_id,
                &media.telegram_file_id,
            )
            .await
            {
                Ok(()) => {
                    info!(telegram_file_id = %media.telegram_file_id, "profile photo downloaded")
                }
                Err(e) => {
                    warn!(
                        telegram_file_id = %media.telegram_file_id,
                        error = %e,
                        "profile photo download failed"
                    );
                    cx::mark_media_failed(&ctx.convex, &media.telegram_file_id, &e.to_string())
                        .await;
                }
            }
            return Ok(());
        }

        // Message-media path (original behaviour).
        let (chat_ext_id, msg_id) = match parse_media_external_id(&media.telegram_file_id) {
            Some(parsed) => parsed,
            None => {
                let err = "invalid media external ID format";
                warn!(telegram_file_id = %media.telegram_file_id, err);
                cx::mark_media_failed(&ctx.convex, &media.telegram_file_id, err).await;
                return Ok(());
            }
        };

        let content_type = media
            .mime_type
            .as_deref()
            .unwrap_or_else(|| default_mime_for_kind_str(&kind_str));

        match download_and_upload(
            &ctx.convex,
            &tg,
            &chat_ext_id,
            msg_id,
            &media.telegram_file_id,
            content_type,
            media.mime_type.as_deref(),
            media.file_name.as_deref(),
            media.width,
            media.height,
            media.duration,
            media.file_size.and_then(|s| {
                if s.is_finite() && s >= 0.0 && s <= usize::MAX as f64 {
                    Some(s as usize)
                } else {
                    None
                }
            }),
        )
        .await
        {
            Ok(()) => info!(telegram_file_id = %media.telegram_file_id, "downloaded"),
            Err(e) => {
                warn!(
                    telegram_file_id = %media.telegram_file_id,
                    error = %e,
                    "download failed"
                );
                cx::mark_media_failed(&ctx.convex, &media.telegram_file_id, &e.to_string()).await;
            }
        }

        Ok(())
    }
}

/// Download a chat's profile photo from Telegram, upload it to Convex storage,
/// and update the chat record.  This is the profile-photo counterpart to
/// `download_and_upload` for message media.
async fn download_profile_photo(
    convex: &convex_backend::ConvexApiClient,
    tg: &messanger_telegram::TelegramClient,
    chat_id: &str,
    chat_ext_id: &str,
    telegram_file_id: &str,
) -> Result<(), WorkerError> {
    // 1. Download from Telegram.
    let photo_bytes = match tg.download_chat_photo(chat_ext_id).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            return Err(WorkerError::MutationFailed(
                "chat has no profile photo".into(),
            ));
        }
        Err(e) => {
            return Err(WorkerError::MutationFailed(format!(
                "failed to download profile photo: {e}"
            )));
        }
    };

    // 2. Get a presigned upload URL.
    let upload_url = convex
        .media_generate_upload_url()
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

    // 3. Upload to Convex storage.
    let http_client = reqwest::Client::new();
    let response = http_client
        .post(&upload_url)
        .header("Content-Type", "image/jpeg")
        .body(photo_bytes.clone())
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

    // 4. Update the chat record with the new photo.
    convex
        .chats_worker_update_chat_photo(ChatsWorkerUpdateChatPhotoArgs {
            chatId: chat_id.to_string(),
            storageId: storage_id.to_string(),
            photoExternalId: telegram_file_id.to_string(),
        })
        .await
        .check()?;

    // 5. Mark the media record as stored.
    convex
        .media_worker_store_media(MediaWorkerStoreMediaArgs {
            telegramFileId: telegram_file_id.to_string(),
            storageId: storage_id.to_string(),
            mimeType: Some("image/jpeg".to_string()),
            fileName: None,
            fileSize: Some(photo_bytes.len() as f64),
            width: None,
            height: None,
            duration: None,
        })
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

    Ok(())
}
