//! MediaDownloader — Restate virtual object for downloading pending media.
//!
//! Keyed by `client_id`. Polls Convex for pending media records and downloads
//! them from Telegram, streaming directly to Convex storage.

use std::sync::Arc;

use convex_backend::{ConvexApi, ConvexApiClient, MediaListPendingForClientArgs};
use futures::StreamExt;
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{info, warn};

use crate::client_pool::ClientPool;
use crate::error::WorkerError;
use crate::ops::convex as cx;
use crate::ops::media::download_and_upload;
use crate::ops::telegram::{default_mime_for_pending_kind, parse_media_external_id};

use super::ScanRequest;

#[restate_sdk::object]
pub trait MediaDownloader {
    async fn download(req: Json<ScanRequest>) -> Result<(), HandlerError>;
    async fn stop() -> Result<(), HandlerError>;
}

pub struct MediaDownloaderImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl MediaDownloader for MediaDownloaderImpl {
    async fn download(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<ScanRequest>,
    ) -> Result<(), HandlerError> {
        let req = req.into_inner();
        info!(client_id = %req.client_id, "MediaDownloader: starting");

        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.external_id)
            .await
            .map_err(anyhow::Error::from)?;

        download_pending_media(&self.convex, &tg_client, &req.client_id)
            .await
            .map_err(anyhow::Error::from)?;
        Ok(())
    }

    async fn stop(&self, ctx: ObjectContext<'_>) -> Result<(), HandlerError> {
        info!("MediaDownloader: stop requested");
        ctx.set("cancelled", true);
        Ok(())
    }
}

/// Download all pending media for a client.
pub async fn download_pending_media(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    client_id: &str,
) -> Result<(), WorkerError> {
    let concurrency: usize = std::env::var("DOWNLOAD_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);

    let mut total_success = 0usize;
    let mut total_failed = 0usize;

    loop {
        let pending = convex
            .query_media_list_pending_for_client(MediaListPendingForClientArgs {
                clientId: client_id.to_string(),
            })
            .await?;
        if pending.is_empty() {
            break;
        }

        info!(count = pending.len(), concurrency, "Downloading pending media batch");

        let convex = convex.clone();
        let results: Vec<bool> = futures::stream::iter(pending.into_iter().map(|record| {
            let convex = convex.clone();
            let tg_client = tg_client.clone();
            async move {
                let (chat_ext_id, msg_id) =
                    match parse_media_external_id(&record.telegram_file_id) {
                        Some(parsed) => parsed,
                        None => {
                            warn!(external_id = %record.telegram_file_id, "Invalid media external ID");
                            cx::mark_media_failed(
                                &convex,
                                &record.telegram_file_id,
                                "Invalid external ID format",
                            )
                            .await;
                            return false;
                        }
                    };

                let content_type = default_mime_for_pending_kind(&record.kind);
                match download_and_upload(
                    &convex,
                    &tg_client,
                    &chat_ext_id,
                    msg_id,
                    &record.telegram_file_id,
                    content_type,
                    None,
                    None,
                    None,
                    None,
                    None,
                    record.file_size.map(|s| s as usize),
                )
                .await
                {
                    Ok(()) => true,
                    Err(e) => {
                        warn!(
                            external_id = %record.telegram_file_id,
                            error = %e,
                            "Failed to upload media"
                        );
                        cx::mark_media_failed(
                            &convex,
                            &record.telegram_file_id,
                            &e.to_string(),
                        )
                        .await;
                        false
                    }
                }
            }
        }))
        .buffer_unordered(concurrency)
        .collect()
        .await;

        let success = results.iter().filter(|&&ok| ok).count();
        let failed = results.len() - success;
        total_success += success;
        total_failed += failed;

        info!(success, failed, "Batch complete");
    }

    if total_success > 0 || total_failed > 0 {
        info!(total_success, total_failed, "All pending media processed");
    } else {
        info!("No pending media to download");
    }
    Ok(())
}
