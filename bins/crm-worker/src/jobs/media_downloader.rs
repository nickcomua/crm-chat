//! MediaDownloader — download a single media file from Telegram and upload it
//! to Convex storage.
//!
//! Trigger: `media.pendingWork` entry (capped client-side by `maxDownloads`).

use std::sync::Arc;

use async_trait::async_trait;
use convex_backend::{ClientsGetForWorkerArgs, ConvexApi, MediaGetForDownloadArgs, MediaStatus};
use futures::{StreamExt, stream::BoxStream};
use tracing::{info, warn};

use crate::job::{Job, JobCtx};
use crate::ops::convex as cx;
use crate::ops::media::download_and_upload;
use crate::ops::telegram::{default_mime_for_kind_str, parse_media_external_id};
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
