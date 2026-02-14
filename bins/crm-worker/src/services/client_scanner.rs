//! ClientScanner — Restate virtual object for scanning connected Telegram clients.
//!
//! Each connected Telegram client gets its own virtual object keyed by `client_id`.
//! Exclusive handlers guarantee one scan operation at a time per client.
//!
//! Scan lifecycle:
//! 1. `start_scan()` — sync dialogs, profile photos, full-scan messages, download
//!    media, then enter the real-time listen loop
//! 2. `stop_scan()` — sets a cancellation flag; the listener exits on next iteration

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use convex_backend::{
    ChatsListForWorkerArgs, ChatsMarkFullScannedArgs, ChatsTable, ChatsUpdatePhotoArgs,
    ChatsUpdateSyncProgressArgs, ChatsUpdateSyncProgressScanPhase, ChatsUpsertArgs,
    ConvexApi, ConvexApiClient, MediaListPendingForClientArgs, MediaListPendingForClientReturn,
    MediaStoreMediaArgs, MessagesMarkDeletedArgs, MessagesUpsertArgs,
};
use futures::StreamExt;
use messanger_interface::media::MediaSummary;
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

use crate::client_pool::ClientPool;
use crate::config;
use crate::error::WorkerError;
use crate::ops::convex as cx;
use crate::ops::telegram::{
    default_mime_for_kind, default_mime_for_pending_kind, parse_media_external_id,
    to_upsert_media_kind,
};

// ────────────────────────────────────────────────────────────────────────────
// Request types
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct StartScanRequest {
    pub client_id: String,
    pub user_id: String,
    pub external_id: String,
}

// ────────────────────────────────────────────────────────────────────────────
// Virtual object definition
// ────────────────────────────────────────────────────────────────────────────

#[restate_sdk::object]
pub trait ClientScanner {
    async fn start_scan(req: Json<StartScanRequest>) -> Result<(), HandlerError>;
    async fn stop_scan() -> Result<(), HandlerError>;
}

pub struct ClientScannerImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl ClientScanner for ClientScannerImpl {
    async fn start_scan(
        &self,
        ctx: ObjectContext<'_>,
        req: Json<StartScanRequest>,
    ) -> Result<(), HandlerError> {
        let req = req.into_inner();
        info!(
            client_id = %req.client_id,
            external_id = %req.external_id,
            "ClientScanner: start_scan"
        );

        // Mark scan as active in Restate state
        ctx.set("active", true);

        let result = self.run_scan_lifecycle(&ctx, &req).await;

        // Clear active flag on exit
        ctx.set("active", false);

        match result {
            Ok(()) => {
                info!(client_id = %req.client_id, "Scan completed");
                Ok(())
            }
            Err(e) => {
                error!(client_id = %req.client_id, error = %e, "Scan failed");
                // SessionNotFound is terminal — retrying won't make a missing file appear.
                // ClientBuildFailed is also terminal — the session is corrupt/unauthorized.
                match &e {
                    WorkerError::SessionNotFound(_) | WorkerError::ClientBuildFailed(_) => {
                        Err(TerminalError::new(e.to_string()).into())
                    }
                    _ => Err(HandlerError::from(anyhow::Error::from(e))),
                }
            }
        }
    }

    async fn stop_scan(&self, ctx: ObjectContext<'_>) -> Result<(), HandlerError> {
        info!("ClientScanner: stop_scan requested");
        ctx.set("cancelled", true);
        Ok(())
    }
}

impl ClientScannerImpl {
    /// Check if this scan has been cancelled.
    async fn is_cancelled(&self, ctx: &ObjectContext<'_>) -> bool {
        ctx.get::<bool>("cancelled")
            .await
            .ok()
            .flatten()
            .unwrap_or(false)
    }

    /// Run the full scan lifecycle for a connected client.
    async fn run_scan_lifecycle(
        &self,
        ctx: &ObjectContext<'_>,
        req: &StartScanRequest,
    ) -> Result<(), WorkerError> {
        // Reset cancel flag
        ctx.set("cancelled", false);

        // Resolve session path
        let session_path = config::get_session_path(&req.external_id, &req.user_id);
        if !session_path.exists() {
            return Err(WorkerError::SessionNotFound(format!(
                "No session file found for {}",
                req.external_id
            )));
        }

        // Build Telegram client
        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.external_id)
            .await?;

        // Verify authorization
        match tg_client.is_authorized().await {
            Ok(true) => info!("Telegram client authorized"),
            Ok(false) => {
                return Err(WorkerError::ClientBuildFailed(
                    "Client session exists but is not authorized".to_string(),
                ));
            }
            Err(e) => {
                warn!(error = %e, "Failed to check authorization, proceeding");
            }
        }

        // Phase 1: Sync dialogs (fast — needed before listener can process updates)
        if self.is_cancelled(ctx).await {
            return Ok(());
        }
        self.sync_dialogs(req, &tg_client).await?;

        if self.is_cancelled(ctx).await {
            return Ok(());
        }

        // Spawn heavy background work (profile photos, message scan, media download)
        // so the real-time listener can start immediately.
        let bg_convex = self.convex.clone();
        let bg_pool = self.pool.clone();
        let bg_req = StartScanRequest {
            client_id: req.client_id.clone(),
            user_id: req.user_id.clone(),
            external_id: req.external_id.clone(),
        };
        let bg_tg = tg_client.clone();
        let bg_handle = tokio::spawn(async move {
            let scanner = ClientScannerImpl {
                convex: bg_convex,
                pool: bg_pool,
            };

            // Phase 1b: Profile photos
            if let Err(e) = scanner.sync_profile_photos(&bg_req, &bg_tg).await {
                warn!(error = %e, "Background profile photo sync failed");
            }

            // Phase 2: Full message scan
            if let Err(e) = scanner.full_scan_messages(&bg_req, &bg_tg).await {
                warn!(error = %e, "Background message scan failed");
            }

            // Phase 3: Media download
            scanner
                .set_scan_phase_for_client(
                    &bg_req,
                    ChatsUpdateSyncProgressScanPhase::DownloadingMedia,
                )
                .await;
            if let Err(e) = scanner.download_pending_media(&bg_req, &bg_tg).await {
                warn!(error = %e, "Background media download failed");
            }

            info!(client_id = %bg_req.client_id, "Background scan phases complete");
        });

        // Start real-time listener immediately (runs concurrently with background scan)
        self.set_scan_phase_for_client(req, ChatsUpdateSyncProgressScanPhase::Listening)
            .await;
        let result = self.listen_updates(ctx, req, &tg_client).await;

        // Clean up background task when listener exits
        bg_handle.abort();

        result
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 1: Dialog sync
    // ────────────────────────────────────────────────────────────────────────

    async fn sync_dialogs(
        &self,
        req: &StartScanRequest,
        tg_client: &TelegramClient,
    ) -> Result<(), WorkerError> {
        info!(client_id = %req.client_id, "Syncing dialogs");

        let mut stream = tg_client
            .iter_dialogs()
            .await
            .map_err(|e| WorkerError::MutationFailed(format!("Failed to iterate dialogs: {e}")))?;

        let mut count = 0u32;
        while let Some(result) = stream.next().await {
            let dialog = match result {
                Ok(d) => d,
                Err(e) => {
                    warn!(error = %e, "Error reading dialog, skipping");
                    continue;
                }
            };

            let chat_id = format!("{}:{}", req.client_id, dialog.external_id);
            let chat_type = cx::map_chat_type(dialog.chat_type.as_deref());

            self.convex
                .chats_upsert(ChatsUpsertArgs {
                    chatId: chat_id,
                    userId: req.user_id.clone(),
                    clientId: req.client_id.clone(),
                    chatType: chat_type,
                    isPinned: dialog.is_pinned,
                    pinnedName: dialog.name.clone(),
                    lastMessageTimestamp: 0.0,
                })
                .await?;

            count += 1;
        }

        info!(count, "Dialog sync complete");
        Ok(())
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 1b: Profile photo sync
    // ────────────────────────────────────────────────────────────────────────

    async fn sync_profile_photos(
        &self,
        req: &StartScanRequest,
        tg_client: &TelegramClient,
    ) -> Result<(), WorkerError> {
        let chats = self.list_worker_chats(&req.client_id).await?;
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
                .strip_prefix(&format!("{}:", req.client_id))
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

            match self
                .upload_photo_to_convex(&chat.chat_id, &tg_photo_id, &photo_bytes)
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
        &self,
        chat_id: &str,
        photo_external_id: &str,
        photo_bytes: &[u8],
    ) -> Result<(), WorkerError> {
        let upload_url = self.convex.media_generate_upload_url().await?;

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

        self.convex
            .chats_update_photo(ChatsUpdatePhotoArgs {
                chatId: chat_id.to_string(),
                storageId: storage_id.to_string(),
                photoExternalId: photo_external_id.to_string(),
            })
            .await?;

        Ok(())
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 2: Full message scan
    // ────────────────────────────────────────────────────────────────────────

    async fn full_scan_messages(
        &self,
        req: &StartScanRequest,
        tg_client: &TelegramClient,
    ) -> Result<(), WorkerError> {
        let chats = self.list_worker_chats(&req.client_id).await?;

        let to_scan: Vec<_> = chats
            .iter()
            .filter(|c| c.scan_enabled.unwrap_or(false) && !c.full_scanned.unwrap_or(false))
            .collect();

        if to_scan.is_empty() {
            info!("No chats need full scanning");
            return Ok(());
        }

        info!(count = to_scan.len(), "Starting full message scan");

        for chat in to_scan {
            let chat_external_id = chat
                .chat_id
                .strip_prefix(&format!("{}:", req.client_id))
                .unwrap_or(&chat.chat_id);

            info!(chat_id = %chat.chat_id, chat_external_id, "Scanning messages");

            let total_messages = tg_client
                .get_messages_count(&chat_external_id.to_string())
                .await
                .unwrap_or(0);

            self.convex
                .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                    chatId: chat.chat_id.clone(),
                    totalMessages: Some(total_messages as f64),
                    syncedMessages: Some(0.0),
                    scanPhase: Some(ChatsUpdateSyncProgressScanPhase::ScanningMessages),
                })
                .await
                .ok();

            let mut msg_stream =
                match tg_client.iter_messages(&chat_external_id.to_string()).await {
                    Ok(s) => s,
                    Err(e) => {
                        warn!(chat_id = %chat.chat_id, error = %e, "Failed to iterate messages");
                        continue;
                    }
                };

            let mut msg_count = 0u32;
            let mut last_ts = 0.0f64;
            while let Some(result) = msg_stream.next().await {
                let msg = match result {
                    Ok(m) => m,
                    Err(e) => {
                        warn!(error = %e, "Error reading message, skipping");
                        continue;
                    }
                };

                let ts = msg.timestamp_ms.map(|t| t as f64).unwrap_or(0.0);
                if ts > last_ts {
                    last_ts = ts;
                }

                let message_id = format!("{}:{}", chat.chat_id, msg.external_id);

                self.convex
                    .messages_upsert(MessagesUpsertArgs {
                        messageId: message_id,
                        externalId: msg.external_id,
                        userId: req.user_id.clone(),
                        clientId: req.client_id.clone(),
                        chatId: chat.chat_id.clone(),
                        senderId: msg.sender_id,
                        text: msg.text,
                        outgoing: msg.outgoing,
                        deleted: false,
                        timestamp: ts,
                        mediaExternalId: msg.media_external_id,
                        mediaKind: msg
                            .media_summary
                            .as_ref()
                            .map(|s| to_upsert_media_kind(s.kind)),
                    })
                    .await?;

                msg_count += 1;

                if msg_count.is_multiple_of(100) {
                    self.convex
                        .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                            chatId: chat.chat_id.clone(),
                            totalMessages: None,
                            syncedMessages: Some(msg_count as f64),
                            scanPhase: None,
                        })
                        .await
                        .ok();
                }
            }

            // Update lastMessageTs
            if last_ts > 0.0 {
                self.convex
                    .chats_upsert(ChatsUpsertArgs {
                        chatId: chat.chat_id.clone(),
                        userId: req.user_id.clone(),
                        clientId: req.client_id.clone(),
                        chatType: cx::map_chat_type(None),
                        isPinned: chat.is_pinned,
                        pinnedName: chat.pinned_name.clone(),
                        lastMessageTimestamp: last_ts,
                    })
                    .await?;
            }

            self.convex
                .chats_mark_full_scanned(ChatsMarkFullScannedArgs {
                    chatId: chat.chat_id.clone(),
                })
                .await?;

            self.convex
                .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                    chatId: chat.chat_id.clone(),
                    totalMessages: None,
                    syncedMessages: Some(msg_count as f64),
                    scanPhase: None,
                })
                .await
                .ok();

            info!(chat_id = %chat.chat_id, msg_count, "Chat fully scanned");
        }

        Ok(())
    }

    // ────────────────────────────────────────────────────────────────────────
    // Phase 3: Media download
    // ────────────────────────────────────────────────────────────────────────

    async fn download_pending_media(
        &self,
        req: &StartScanRequest,
        tg_client: &Arc<TelegramClient>,
    ) -> Result<(), WorkerError> {
        let concurrency: usize = std::env::var("DOWNLOAD_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3);

        let mut total_success = 0usize;
        let mut total_failed = 0usize;

        loop {
            let pending: Vec<MediaListPendingForClientReturn> = self
                .convex
                .query_media_list_pending_for_client(MediaListPendingForClientArgs {
                    clientId: req.client_id.clone(),
                })
                .await?;
            if pending.is_empty() {
                break;
            }

            info!(count = pending.len(), concurrency, "Downloading pending media batch");

            let convex = self.convex.clone();
            let results: Vec<bool> = futures::stream::iter(pending.into_iter().map(|record| {
                let convex = convex.clone();
                let tg_client = tg_client.clone();
                async move {
                    let (chat_ext_id, msg_id) = match parse_media_external_id(&record.telegram_file_id) {
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
                            cx::mark_media_failed(&convex, &record.telegram_file_id, &e.to_string())
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

    // ────────────────────────────────────────────────────────────────────────
    // Phase 4: Real-time update listener
    // ────────────────────────────────────────────────────────────────────────

    async fn listen_updates(
        &self,
        ctx: &ObjectContext<'_>,
        req: &StartScanRequest,
        tg_client: &Arc<TelegramClient>,
    ) -> Result<(), WorkerError> {
        info!(client_id = %req.client_id, "Starting real-time update listener");

        let mut update_stream = tg_client
            .iter_updates()
            .await
            .map_err(|e| WorkerError::MutationFailed(format!("Failed to start updates: {e}")))?;

        let mut scan_enabled_chats = self.load_scan_enabled_chats(req).await?;
        let refresh_secs: u64 = std::env::var("SCAN_REFRESH_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60);
        let mut refresh_interval =
            tokio::time::interval(std::time::Duration::from_secs(refresh_secs));
        refresh_interval.tick().await; // consume first immediate tick

        let mut backfill_handle: Option<tokio::task::JoinHandle<()>> = None;

        loop {
            // Check cancellation first
            if self.is_cancelled(ctx).await {
                info!("Update listener cancelled");
                if let Some(h) = backfill_handle.take() {
                    h.abort();
                }
                return Ok(());
            }

            tokio::select! {
                biased;

                // Periodically refresh scan-enabled chats and drain pending media
                _ = refresh_interval.tick() => {
                    if backfill_handle.as_ref().is_some_and(|h| !h.is_finished()) {
                        debug!("Backfill still running, skipping refresh");
                        continue;
                    }

                    let chats_changed = match self.load_scan_enabled_chats(req).await {
                        Ok(new_set) => {
                            let changed = new_set != scan_enabled_chats;
                            if changed {
                                info!(count = new_set.len(), "Refreshed scan-enabled chats");
                                scan_enabled_chats = new_set;
                            }
                            changed
                        }
                        Err(e) => {
                            warn!(error = %e, "Failed to refresh scan-enabled chats");
                            false
                        }
                    };

                    // Spawn background backfill task
                    let convex = self.convex.clone();
                    let pool = self.pool.clone();
                    let bf_req = StartScanRequest {
                        client_id: req.client_id.clone(),
                        user_id: req.user_id.clone(),
                        external_id: req.external_id.clone(),
                    };
                    let bf_tg = tg_client.clone();
                    backfill_handle = Some(tokio::spawn(async move {
                        let scanner = ClientScannerImpl { convex, pool };
                        if chats_changed
                            && let Err(e) = scanner.full_scan_messages(&bf_req, &bf_tg).await
                        {
                            warn!(error = %e, "Failed to backfill newly-enabled chats");
                        }
                        if let Err(e) = scanner.download_pending_media(&bf_req, &bf_tg).await {
                            warn!(error = %e, "Failed to download pending media");
                        }
                        // Reset scanPhase back to Listening after backfill completes
                        scanner
                            .set_scan_phase_for_client(
                                &bf_req,
                                ChatsUpdateSyncProgressScanPhase::Listening,
                            )
                            .await;
                    }));
                }

                update = update_stream.next() => {
                    match update {
                        Some(Ok(update)) => {
                            if let Err(e) = self.process_update(req, tg_client, &update, &scan_enabled_chats).await {
                                warn!(error = %e, "Failed to process update");
                            }
                        }
                        Some(Err(e)) => {
                            warn!(error = %e, "Error in update stream");
                        }
                        None => {
                            info!("Update stream ended");
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    async fn load_scan_enabled_chats(
        &self,
        req: &StartScanRequest,
    ) -> Result<HashSet<String>, WorkerError> {
        let chats = self.list_worker_chats(&req.client_id).await?;
        Ok(chats
            .iter()
            .filter(|c| c.scan_enabled.unwrap_or(false))
            .filter_map(|c| {
                c.chat_id
                    .strip_prefix(&format!("{}:", req.client_id))
                    .map(|s| s.to_string())
            })
            .collect())
    }

    async fn process_update(
        &self,
        req: &StartScanRequest,
        tg_client: &Arc<TelegramClient>,
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

                self.convex
                    .messages_upsert(MessagesUpsertArgs {
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
                    })
                    .await?;

                // Real-time media download in background
                if matches!(update, Update::NewMessage(_))
                    && let Some(ref summary) = msg.media_summary
                    && let Some(ref media_ext_id) = msg.media_external_id
                {
                    let convex = self.convex.clone();
                    let dl_tg = tg_client.clone();
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
                                "Failed to download media for real-time message"
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
                    self.convex
                        .messages_mark_deleted(MessagesMarkDeletedArgs {
                            externalId: ext_id.clone(),
                        })
                        .await
                        .ok();
                }
            }

            Update::Other { update_type, .. } => {
                debug!(update_type, "Ignoring non-message update");
            }
        }

        Ok(())
    }

    async fn set_scan_phase_for_client(
        &self,
        req: &StartScanRequest,
        phase: ChatsUpdateSyncProgressScanPhase,
    ) {
        let chats = match self.list_worker_chats(&req.client_id).await {
            Ok(c) => c,
            Err(e) => {
                warn!(error = %e, "Failed to query chats for phase update");
                return;
            }
        };

        for chat in chats.iter().filter(|c| c.scan_enabled.unwrap_or(false)) {
            self.convex
                .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                    chatId: chat.chat_id.clone(),
                    totalMessages: None,
                    syncedMessages: None,
                    scanPhase: Some(phase),
                })
                .await
                .ok();
        }
    }

    /// Query the list of chats for a worker's client.
    async fn list_worker_chats(&self, client_id: &str) -> Result<Vec<ChatsTable>, WorkerError> {
        self.convex
            .query_chats_list_for_worker(ChatsListForWorkerArgs {
                clientId: client_id.to_string(),
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Media download & upload pipeline (free functions)
// ────────────────────────────────────────────────────────────────────────────

/// Download and upload media for a single message (used in real-time updates).
async fn download_and_upload_media(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    chat_external_id: &str,
    msg_external_id: &str,
    media_external_id: &str,
    summary: &MediaSummary,
) -> Result<(), WorkerError> {
    let msg_id: i32 = msg_external_id
        .parse()
        .map_err(|_| WorkerError::MutationFailed(format!("Invalid message ID: {msg_external_id}")))?;

    let content_type = summary
        .mime_type
        .as_deref()
        .unwrap_or_else(|| default_mime_for_kind(summary.kind));

    download_and_upload(
        convex,
        tg_client,
        chat_external_id,
        msg_id,
        media_external_id,
        content_type,
        summary.mime_type.as_deref(),
        summary.file_name.as_deref(),
        summary.width.map(|w| w as f64),
        summary.height.map(|h| h as f64),
        summary.duration,
        summary.file_size,
    )
    .await
}

/// Stream-download from Telegram and pipe directly to Convex storage upload.
///
/// The file never sits fully in memory — chunks stream from the Telegram
/// download receiver directly into the reqwest upload body. Progress is
/// reported to Convex every ~2 seconds.
#[allow(clippy::too_many_arguments)]
async fn download_and_upload(
    convex: &ConvexApiClient,
    tg_client: &Arc<TelegramClient>,
    chat_external_id: &str,
    msg_id: i32,
    external_id: &str,
    content_type: &str,
    mime_type: Option<&str>,
    file_name: Option<&str>,
    width: Option<f64>,
    height: Option<f64>,
    duration: Option<f64>,
    known_file_size: Option<usize>,
) -> Result<(), WorkerError> {
    // Step 0: Transition to "downloading" status
    cx::start_download(convex, external_id).await;

    // Step 1: Get a presigned upload URL
    let upload_url = convex
        .media_generate_upload_url()
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

    // Step 2: Start the streaming download
    let media_stream = tg_client
        .stream_message_media(chat_external_id, msg_id)
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("Failed to download from Telegram: {e}")))?
        .ok_or_else(|| {
            WorkerError::MutationFailed("No media in Telegram message".to_string())
        })?;

    let file_size = media_stream.file_size.or(known_file_size);

    // Wrap the chunk receiver into a streaming body with byte counter
    let bytes_counter = Arc::new(AtomicUsize::new(0));
    let counter_for_stream = bytes_counter.clone();
    let stream =
        tokio_stream::wrappers::ReceiverStream::new(media_stream.chunks).map(move |chunk| {
            if let Ok(ref data) = chunk {
                counter_for_stream.fetch_add(data.len(), Ordering::Relaxed);
            }
            chunk
        });
    let body = reqwest::Body::wrap_stream(stream);

    // Progress reporter
    let progress_convex = convex.clone();
    let progress_ext_id = external_id.to_string();
    let progress_bytes = bytes_counter.clone();
    let progress_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        interval.tick().await;
        loop {
            interval.tick().await;
            let current = progress_bytes.load(Ordering::Relaxed);
            cx::update_download_progress(
                &progress_convex,
                &progress_ext_id,
                current as f64,
                file_size.map(|s| s as f64),
            )
            .await;
        }
    });

    // Step 3: Upload to Convex storage
    let http_client = reqwest::Client::new();
    let response = http_client
        .post(&upload_url)
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| {
            progress_handle.abort();
            WorkerError::MutationFailed(format!("Failed to upload to Convex storage: {e}"))
        })?;

    // Step 4: Wait for download to complete
    let total_bytes = media_stream
        .download_handle
        .await
        .map_err(|e| {
            progress_handle.abort();
            WorkerError::MutationFailed(format!("Download task panicked: {e}"))
        })?
        .map_err(|e| {
            progress_handle.abort();
            WorkerError::MutationFailed(format!("Failed to download from Telegram: {e}"))
        })?;

    progress_handle.abort();

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(WorkerError::MutationFailed(format!(
            "Convex storage upload failed (HTTP {status}): {body}"
        )));
    }

    let upload_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| WorkerError::MutationFailed(format!("Failed to parse upload response: {e}")))?;

    let storage_id = upload_result["storageId"].as_str().ok_or_else(|| {
        WorkerError::MutationFailed("Missing storageId in upload response".to_string())
    })?;

    // Step 5: Store the media record
    let final_size = file_size.unwrap_or(total_bytes);
    convex
        .media_store_media(MediaStoreMediaArgs {
            telegramFileId: external_id.to_string(),
            storageId: storage_id.to_string(),
            mimeType: mime_type.map(String::from),
            fileName: file_name.map(String::from),
            fileSize: Some(final_size as f64),
            width,
            height,
            duration,
        })
        .await
        .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

    info!(
        external_id,
        storage_id,
        total_bytes,
        ?file_size,
        content_type,
        "Media streamed to Convex storage"
    );
    Ok(())
}
