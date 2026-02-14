//! Chat scanning module for connected Telegram clients.
//!
//! After a client reaches "Connected" status, this module:
//! 1. Syncs Telegram dialogs to Convex (upserts chats)
//! 2. Full-scans messages for scan-enabled chats (sets fullScanned)
//! 3. Listens for real-time updates via iter_updates

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use convex_backend::{
    ChatsListForRobotArgs, ChatsMarkFullScannedArgs, ChatsUpdatePhotoArgs,
    ChatsUpdateSyncProgressArgs, ChatsUpdateSyncProgressScanPhase, ChatsUpsertArgs,
    ChatsUpsertChatType, MediaListPendingForClientArgs, MediaListPendingForClientReturnKind,
    MediaMarkFailedArgs, MediaStartDownloadArgs, MediaStoreMediaArgs, MediaUpdateProgressArgs,
    MessagesMarkDeletedArgs, MessagesUpsertArgs,
};
use futures::StreamExt;
use messanger_interface::media::MediaSummary;
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;
use crate::types::{Client, ConvexApi, check_result, to_upsert_media_kind};

/// Run the full scan lifecycle for a connected client.
///
/// This function runs indefinitely (until cancelled) and:
/// 1. Syncs Telegram dialogs → Convex chats
/// 2. Full-scans messages for scan-enabled (and not yet fully scanned) chats
/// 3. Listens for real-time updates
#[instrument(skip(ctx, cancel), fields(client_id = %client.id, external_id = %client.external_id))]
pub async fn scan_client(
    ctx: &TaskExecutionContext,
    client: &Client,
    cancel: CancellationToken,
) -> Result<(), TaskError> {
    info!("Starting scan for connected client");

    // Resolve the session file path for this client
    let session_path = resolve_session_path(client).ok_or_else(|| {
        TaskError::ClientBuildFailed(format!(
            "No session file found for client {}",
            client.external_id
        ))
    })?;

    info!(session_path = ?session_path, "Resolved session path");

    // Build a TelegramClient from the persisted session
    let tg_client = Arc::new(
        TelegramClient::new(
            ctx.config.api_id,
            ctx.config.api_hash.clone(),
            session_path.to_string_lossy().to_string(),
        )
        .await
        .map_err(|e| TaskError::ClientBuildFailed(e.to_string()))?,
    );

    // Verify the client is actually authorized
    match tg_client.is_authorized().await {
        Ok(true) => info!("Telegram client authorized, proceeding with scan"),
        Ok(false) => {
            warn!("Telegram client is not authorized, cannot scan");
            return Err(TaskError::ClientBuildFailed(
                "Client session exists but is not authorized".to_string(),
            ));
        }
        Err(e) => {
            warn!(error = %e, "Failed to check authorization, proceeding anyway");
        }
    }

    // Phase 1: Sync dialogs
    if cancel.is_cancelled() {
        return Ok(());
    }
    sync_dialogs(ctx, client, &tg_client).await?;

    // Phase 1b: Sync profile photos
    if cancel.is_cancelled() {
        return Ok(());
    }
    sync_profile_photos(ctx, client, &tg_client).await?;

    // Phase 2: Full message scan for scan-enabled chats
    if cancel.is_cancelled() {
        return Ok(());
    }
    full_scan_messages(ctx, client, &tg_client).await?;

    // Phase 3: Download pending media from current and previous scans
    if cancel.is_cancelled() {
        return Ok(());
    }
    // Set scan phase to downloading_media on all scan-enabled chats
    set_scan_phase_for_client(
        ctx,
        client,
        ChatsUpdateSyncProgressScanPhase::DownloadingMedia,
    )
    .await;
    download_pending_media(ctx, client, &tg_client).await?;

    // Phase 4: Listen for real-time updates (runs until cancelled)
    set_scan_phase_for_client(ctx, client, ChatsUpdateSyncProgressScanPhase::Listening).await;
    listen_updates(ctx, client, &tg_client, cancel).await?;

    Ok(())
}

/// Resolve the session file path for a connected client.
fn resolve_session_path(client: &Client) -> Option<PathBuf> {
    let path = crate::config::get_session_path(&client.external_id, &client.user_id);
    if path.exists() { Some(path) } else { None }
}

/// Sync Telegram dialogs to Convex chats.
///
/// Iterates all dialogs from the Telegram client and upserts each one
/// as a chat in Convex. On first insert, `scanEnabled` defaults to `isPinned`.
#[instrument(skip(ctx, tg_client), fields(client_id = %client.id))]
async fn sync_dialogs(
    ctx: &TaskExecutionContext,
    client: &Client,
    tg_client: &TelegramClient,
) -> Result<(), TaskError> {
    info!("Syncing dialogs");

    let mut stream = tg_client
        .iter_dialogs()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to iterate dialogs: {e}")))?;

    let mut count = 0u32;
    while let Some(result) = stream.next().await {
        let dialog = match result {
            Ok(d) => d,
            Err(e) => {
                warn!(error = %e, "Error reading dialog, skipping");
                continue;
            }
        };

        let chat_id = format!("{}:{}", client.id, dialog.external_id);
        let chat_type = map_chat_type(dialog.chat_type.as_deref());

        check_result(
            ctx.client
                .clone()
                .chats_upsert(ChatsUpsertArgs {
                    chatId: chat_id,
                    userId: client.user_id.clone(),
                    clientId: client.id.clone(),
                    chatType: chat_type,
                    isPinned: dialog.is_pinned,
                    pinnedName: dialog.name.clone(),
                    lastMessageTs: 0.0, // Will be updated when messages are synced
                })
                .await,
        )?;

        count += 1;
    }

    info!(count, "Dialog sync complete");
    Ok(())
}

/// Download and upload profile photos for chats whose photo has changed or is missing.
///
/// Uses Telegram's `photo_id` for change detection — only re-downloads when
/// the ID differs from what Convex already has.
#[instrument(skip(ctx, tg_client), fields(client_id = %client.id))]
async fn sync_profile_photos(
    ctx: &TaskExecutionContext,
    client: &Client,
    tg_client: &TelegramClient,
) -> Result<(), TaskError> {
    let chats = ctx
        .client
        .clone()
        .query_chats_list_for_robot(ChatsListForRobotArgs {
            clientId: client.id.clone(),
        })
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to query chats: {e}")))?;

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

        // Step 1: Get the current Telegram photo_id
        let tg_photo_id = match tg_client.get_chat_photo_id(chat_external_id).await {
            Ok(Some(id)) => id,
            Ok(None) => {
                skipped += 1;
                continue; // No photo set on this chat
            }
            Err(e) => {
                debug!(chat_id = %chat.chat_id, error = %e, "Failed to get photo ID, skipping");
                failed += 1;
                continue;
            }
        };

        // Step 2: Compare with stored photo_external_id — skip if unchanged
        if chat
            .photo_external_id
            .as_deref()
            .is_some_and(|stored| stored == tg_photo_id)
        {
            skipped += 1;
            continue;
        }

        // Step 3: Download the photo bytes
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

        // Step 4: Upload to Convex and update the chat record
        match upload_photo_to_convex(ctx, &chat.chat_id, &tg_photo_id, &photo_bytes).await {
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

/// Upload photo bytes to Convex storage and update the chat record.
async fn upload_photo_to_convex(
    ctx: &TaskExecutionContext,
    chat_id: &str,
    photo_external_id: &str,
    photo_bytes: &[u8],
) -> Result<(), TaskError> {
    // Get a presigned upload URL
    let upload_url = ctx
        .client
        .clone()
        .media_generate_upload_url()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to generate upload URL: {e}")))?;

    // Upload the photo
    let http_client = reqwest::Client::new();
    let response = http_client
        .post(&upload_url)
        .header("Content-Type", "image/jpeg")
        .body(photo_bytes.to_vec())
        .send()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to upload photo: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(TaskError::MutationFailed(format!(
            "Photo upload failed (HTTP {status}): {body}"
        )));
    }

    let upload_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to parse upload response: {e}")))?;

    let storage_id = upload_result["storageId"].as_str().ok_or_else(|| {
        TaskError::MutationFailed("Missing storageId in upload response".to_string())
    })?;

    // Update the chat record
    check_result(
        ctx.client
            .clone()
            .chats_update_photo(ChatsUpdatePhotoArgs {
                chatId: chat_id.to_string(),
                storageId: storage_id.to_string(),
                photoExternalId: photo_external_id.to_string(),
            })
            .await,
    )?;

    Ok(())
}

/// Full message scan for scan-enabled chats that haven't been fully scanned yet.
#[instrument(skip(ctx, tg_client), fields(client_id = %client.id))]
async fn full_scan_messages(
    ctx: &TaskExecutionContext,
    client: &Client,
    tg_client: &TelegramClient,
) -> Result<(), TaskError> {
    // Query chats for this client
    let chats = ctx
        .client
        .clone()
        .query_chats_list_for_robot(ChatsListForRobotArgs {
            clientId: client.id.clone(),
        })
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to query chats: {e}")))?;

    // Filter to scan-enabled, not yet fully scanned
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
        // Extract the Telegram chat external_id from the composite chatId
        let chat_external_id = chat
            .chat_id
            .strip_prefix(&format!("{}:", client.id))
            .unwrap_or(&chat.chat_id);

        info!(chat_id = %chat.chat_id, chat_external_id, "Scanning messages");

        // Get total message count and report scan start
        let total_messages = tg_client
            .get_messages_count(&chat_external_id.to_string())
            .await
            .unwrap_or(0);

        let _ = ctx
            .client
            .clone()
            .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                chatId: chat.chat_id.clone(),
                totalMessages: Some(total_messages as f64),
                syncedMessages: Some(0.0),
                scanPhase: Some(ChatsUpdateSyncProgressScanPhase::ScanningMessages),
            })
            .await;

        let mut msg_stream = match tg_client.iter_messages(&chat_external_id.to_string()).await {
            Ok(s) => s,
            Err(e) => {
                warn!(chat_id = %chat.chat_id, error = %e, "Failed to iterate messages, skipping chat");
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

            check_result(
                ctx.client
                    .clone()
                    .messages_upsert(MessagesUpsertArgs {
                        messageId: message_id,
                        externalId: msg.external_id,
                        userId: client.user_id.clone(),
                        clientId: client.id.clone(),
                        chatId: chat.chat_id.clone(),
                        senderId: msg.sender_id,
                        text: msg.text,
                        out: msg.outgoing,
                        deleted: false,
                        ts,
                        mediaId: msg.media_external_id,
                        mediaKind: msg
                            .media_summary
                            .as_ref()
                            .map(|s| to_upsert_media_kind(s.kind)),
                    })
                    .await,
            )?;

            msg_count += 1;

            // Report progress every 100 messages
            if msg_count.is_multiple_of(100) {
                let _ = ctx
                    .client
                    .clone()
                    .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                        chatId: chat.chat_id.clone(),
                        totalMessages: None,
                        syncedMessages: Some(msg_count as f64),
                        scanPhase: None,
                    })
                    .await;
            }
        }

        // Update lastMessageTs on the chat
        if last_ts > 0.0 {
            check_result(
                ctx.client
                    .clone()
                    .chats_upsert(ChatsUpsertArgs {
                        chatId: chat.chat_id.clone(),
                        userId: client.user_id.clone(),
                        clientId: client.id.clone(),
                        chatType: ChatsUpsertChatType::Dialog, // Will be preserved by upsert
                        isPinned: chat.is_pinned,
                        pinnedName: chat.pinned_name.clone(),
                        lastMessageTs: last_ts,
                    })
                    .await,
            )?;
        }

        // Mark as fully scanned and finalize progress
        check_result(
            ctx.client
                .clone()
                .chats_mark_full_scanned(ChatsMarkFullScannedArgs {
                    chatId: chat.chat_id.clone(),
                })
                .await,
        )?;

        let _ = ctx
            .client
            .clone()
            .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                chatId: chat.chat_id.clone(),
                totalMessages: None,
                syncedMessages: Some(msg_count as f64),
                scanPhase: None,
            })
            .await;

        info!(chat_id = %chat.chat_id, msg_count, "Chat fully scanned");
    }

    Ok(())
}

/// Listen for real-time updates from Telegram and sync them to Convex.
///
/// Runs until the cancellation token is triggered.
#[instrument(skip(ctx, tg_client, cancel), fields(client_id = %client.id))]
async fn listen_updates(
    ctx: &TaskExecutionContext,
    client: &Client,
    tg_client: &Arc<TelegramClient>,
    cancel: CancellationToken,
) -> Result<(), TaskError> {
    info!("Starting real-time update listener");

    let mut update_stream = tg_client
        .iter_updates()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to start update stream: {e}")))?;

    // Build set of scan-enabled chat external IDs for filtering
    let mut scan_enabled_chats = load_scan_enabled_chats(ctx, client).await?;
    let refresh_secs: u64 = std::env::var("SCAN_REFRESH_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let mut refresh_interval = tokio::time::interval(std::time::Duration::from_secs(refresh_secs));
    refresh_interval.tick().await; // consume first immediate tick

    // Backfill runs as a separate spawned task so it doesn't block real-time updates.
    let mut backfill_handle: Option<tokio::task::JoinHandle<()>> = None;

    loop {
        tokio::select! {
            biased;

            _ = cancel.cancelled() => {
                info!("Update listener cancelled");
                if let Some(h) = backfill_handle.take() {
                    h.abort();
                }
                return Ok(());
            }

            // Periodically refresh scan-enabled chats and drain pending media
            _ = refresh_interval.tick() => {
                // Skip if a backfill is already running
                if backfill_handle.as_ref().is_some_and(|h| !h.is_finished()) {
                    debug!("Backfill still running, skipping refresh");
                    continue;
                }

                let chats_changed = match load_scan_enabled_chats(ctx, client).await {
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

                // Always spawn a background task to drain pending media.
                // If chats changed, also run full_scan_messages first.
                let bf_ctx = ctx.clone();
                let bf_client = client.clone();
                let bf_tg = tg_client.clone();
                backfill_handle = Some(tokio::spawn(async move {
                    if chats_changed
                        && let Err(e) = full_scan_messages(&bf_ctx, &bf_client, &bf_tg).await
                    {
                        warn!(error = %e, "Failed to backfill newly-enabled chats");
                    }
                    if let Err(e) = download_pending_media(&bf_ctx, &bf_client, &bf_tg).await {
                        warn!(error = %e, "Failed to download pending media");
                    }
                }));
            }

            update = update_stream.next() => {
                match update {
                    Some(Ok(update)) => {
                        if let Err(e) = process_update(ctx, client, tg_client, &update, &scan_enabled_chats).await {
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

/// Load the set of scan-enabled chat external IDs for a client.
async fn load_scan_enabled_chats(
    ctx: &TaskExecutionContext,
    client: &Client,
) -> Result<HashSet<String>, TaskError> {
    let chats = ctx
        .client
        .clone()
        .query_chats_list_for_robot(ChatsListForRobotArgs {
            clientId: client.id.clone(),
        })
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to query chats: {e}")))?;

    Ok(chats
        .iter()
        .filter(|c| c.scan_enabled.unwrap_or(false))
        .filter_map(|c| {
            c.chat_id
                .strip_prefix(&format!("{}:", client.id))
                .map(|s| s.to_string())
        })
        .collect())
}

/// Process a single update event from Telegram.
async fn process_update(
    ctx: &TaskExecutionContext,
    client: &Client,
    tg_client: &Arc<TelegramClient>,
    update: &Update,
    scan_enabled_chats: &HashSet<String>,
) -> Result<(), TaskError> {
    match update {
        Update::NewMessage(msg) | Update::MessageEdited(msg) => {
            // Only process updates for scan-enabled chats
            if !scan_enabled_chats.contains(&msg.chat_external_id) {
                debug!(chat = %msg.chat_external_id, "Skipping update for non-scan-enabled chat");
                return Ok(());
            }

            let chat_id = format!("{}:{}", client.id, msg.chat_external_id);
            let message_id = format!("{}:{}", chat_id, msg.external_id);
            let ts = msg.timestamp_ms.map(|t| t as f64).unwrap_or(0.0);

            check_result(
                ctx.client
                    .clone()
                    .messages_upsert(MessagesUpsertArgs {
                        messageId: message_id,
                        externalId: msg.external_id.clone(),
                        userId: client.user_id.clone(),
                        clientId: client.id.clone(),
                        chatId: chat_id.clone(),
                        senderId: msg.sender_id.clone(),
                        text: msg.text.clone(),
                        out: msg.outgoing,
                        deleted: false,
                        ts,
                        mediaId: msg.media_external_id.clone(),
                        mediaKind: msg
                            .media_summary
                            .as_ref()
                            .map(|s| to_upsert_media_kind(s.kind)),
                    })
                    .await,
            )?;

            // Real-time media download: spawn as a separate task so we don't block
            // the update loop while waiting for the Telegram client Mutex (which may
            // be held by a long-running backfill scan).
            if matches!(update, Update::NewMessage(_))
                && let Some(ref summary) = msg.media_summary
                && let Some(ref media_ext_id) = msg.media_external_id
            {
                let dl_ctx = ctx.clone();
                let dl_tg = tg_client.clone();
                let dl_chat_ext = msg.chat_external_id.clone();
                let dl_msg_ext = msg.external_id.clone();
                let dl_media_ext = media_ext_id.clone();
                let dl_summary = summary.clone();
                tokio::spawn(async move {
                    if let Err(e) = download_and_upload_media(
                        &dl_ctx,
                        &dl_tg,
                        &dl_chat_ext,
                        &dl_msg_ext,
                        &dl_media_ext,
                        &dl_summary,
                    )
                    .await
                    {
                        warn!(media_id = %dl_media_ext, error = %e, "Failed to download media for real-time message");
                    }
                });
            }
        }

        Update::MessageDeleted {
            message_external_ids,
            chat_external_id,
        } => {
            // If we know the chat and it's not scan-enabled, skip
            if let Some(chat_ext_id) = chat_external_id
                && !scan_enabled_chats.contains(chat_ext_id)
            {
                return Ok(());
            }

            for ext_id in message_external_ids {
                if let Err(e) = ctx
                    .client
                    .clone()
                    .messages_mark_deleted(MessagesMarkDeletedArgs {
                        externalId: ext_id.clone(),
                    })
                    .await
                {
                    // Message might not exist in our DB if it was from a non-scanned chat
                    debug!(external_id = %ext_id, error = %e, "Failed to mark message deleted (may not exist)");
                }
            }
        }

        Update::Other { update_type, .. } => {
            debug!(update_type, "Ignoring non-message update");
        }
    }

    Ok(())
}

// ============================================================================
// Media download & upload pipeline
// ============================================================================

/// Download all pending media for a client from Telegram and upload to Convex storage.
///
/// Loops until the pending queue is fully drained (the Convex query returns
/// batches of up to 200).  Up to `DOWNLOAD_CONCURRENCY` files are downloaded
/// in parallel per batch (default 3).
/// Grammers handles Telegram flood-wait errors automatically with backoff.
#[instrument(skip(ctx, tg_client), fields(client_id = %client.id))]
async fn download_pending_media(
    ctx: &TaskExecutionContext,
    client: &Client,
    tg_client: &Arc<TelegramClient>,
) -> Result<(), TaskError> {
    let concurrency: usize = std::env::var("DOWNLOAD_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);

    let mut total_success = 0usize;
    let mut total_failed = 0usize;

    loop {
        let pending = ctx
            .client
            .clone()
            .query_media_list_pending_for_client(MediaListPendingForClientArgs {
                clientId: client.id.clone(),
            })
            .await
            .map_err(|e| {
                TaskError::MutationFailed(format!("Failed to query pending media: {e}"))
            })?;

        if pending.is_empty() {
            break;
        }

        info!(
            count = pending.len(),
            concurrency, "Downloading pending media batch"
        );

        let results: Vec<bool> = futures::stream::iter(pending.into_iter().map(|record| {
            let ctx = ctx.clone();
            let tg_client = tg_client.clone();
            async move {
                let (chat_ext_id, msg_id) = match parse_media_external_id(&record.external_id) {
                    Some(parsed) => parsed,
                    None => {
                        warn!(external_id = %record.external_id, "Invalid media external ID format");
                        mark_media_failed(&ctx, &record.external_id, "Invalid external ID format")
                            .await;
                        return false;
                    }
                };

                let content_type = default_mime_for_pending_kind(&record.kind);
                match download_and_upload(
                    &ctx,
                    &tg_client,
                    &chat_ext_id,
                    msg_id,
                    &record.external_id,
                    content_type,
                    None, // mime_type
                    None, // file_name
                    None, // width
                    None, // height
                    None, // duration
                    record.file_size.map(|s| s as usize),
                )
                .await
                {
                    Ok(()) => true,
                    Err(e) => {
                        warn!(external_id = %record.external_id, error = %e, "Failed to upload media");
                        mark_media_failed(&ctx, &record.external_id, &e.to_string()).await;
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

/// Download and upload media for a single message (used in real-time updates).
async fn download_and_upload_media(
    ctx: &TaskExecutionContext,
    tg_client: &Arc<TelegramClient>,
    chat_external_id: &str,
    msg_external_id: &str,
    media_external_id: &str,
    summary: &MediaSummary,
) -> Result<(), TaskError> {
    let msg_id: i32 = msg_external_id
        .parse()
        .map_err(|_| TaskError::MutationFailed(format!("Invalid message ID: {msg_external_id}")))?;

    let content_type = summary
        .mime_type
        .as_deref()
        .unwrap_or_else(|| default_mime_for_kind(summary.kind));

    download_and_upload(
        ctx,
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
/// `stream_message_media` returns immediately with the file size (from Telegram
/// metadata) and a chunk receiver — the download runs in a spawned task.  The
/// receiver is piped into reqwest's streaming body so the file never sits fully
/// in memory.  Progress is reported to Convex every ~2 s.
#[allow(clippy::too_many_arguments)]
async fn download_and_upload(
    ctx: &TaskExecutionContext,
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
) -> Result<(), TaskError> {
    // Step 0: Transition the media record to "downloading" status
    let _ = ctx
        .client
        .clone()
        .media_start_download(MediaStartDownloadArgs {
            externalId: external_id.to_string(),
        })
        .await;

    // Step 1: Get a presigned upload URL from Convex (before touching Telegram)
    let upload_url = ctx
        .client
        .clone()
        .media_generate_upload_url()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to generate upload URL: {e}")))?;

    // Step 2: Start the streaming download — returns immediately with metadata
    // and a chunk receiver. The download runs in a spawned task.
    let media_stream = tg_client
        .stream_message_media(chat_external_id, msg_id)
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to download from Telegram: {e}")))?
        .ok_or_else(|| TaskError::MutationFailed("No media in Telegram message".to_string()))?;

    // Use the authoritative file size from Telegram metadata, falling back to
    // the known_file_size from the media summary / pending record.
    let file_size = media_stream.file_size.or(known_file_size);

    // Step 2b: Wrap the chunk receiver into a streaming body with a byte counter
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

    // Step 2c: Spawn a progress reporter that reads the byte counter every ~2 s
    let progress_ctx = ctx.clone();
    let progress_ext_id = external_id.to_string();
    let progress_bytes = bytes_counter.clone();
    let progress_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        interval.tick().await; // consume immediate first tick
        loop {
            interval.tick().await;
            let current = progress_bytes.load(Ordering::Relaxed);
            let _ = progress_ctx
                .client
                .clone()
                .media_update_progress(MediaUpdateProgressArgs {
                    externalId: progress_ext_id.clone(),
                    bytesDownloaded: current as f64,
                    fileSize: file_size.map(|s| s as f64),
                })
                .await;
        }
    });

    // Step 3: Upload the streaming body to Convex storage with correct Content-Type
    let http_client = reqwest::Client::new();
    let response = http_client
        .post(&upload_url)
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| {
            progress_handle.abort();
            TaskError::MutationFailed(format!("Failed to upload to Convex storage: {e}"))
        })?;

    // Step 4: Wait for the download task to finish
    let total_bytes = media_stream
        .download_handle
        .await
        .map_err(|e| {
            progress_handle.abort();
            TaskError::MutationFailed(format!("Download task panicked: {e}"))
        })?
        .map_err(|e| {
            progress_handle.abort();
            TaskError::MutationFailed(format!("Failed to download from Telegram: {e}"))
        })?;

    // Download complete — stop the progress reporter
    progress_handle.abort();

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(TaskError::MutationFailed(format!(
            "Convex storage upload failed (HTTP {status}): {body}"
        )));
    }

    let upload_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to parse upload response: {e}")))?;

    let storage_id = upload_result["storageId"].as_str().ok_or_else(|| {
        TaskError::MutationFailed("Missing storageId in upload response".to_string())
    })?;

    // Step 5: Update the media record in Convex with the storageId + metadata.
    let final_size = file_size.unwrap_or(total_bytes);
    check_result(
        ctx.client
            .clone()
            .media_store_media(MediaStoreMediaArgs {
                externalId: external_id.to_string(),
                storageId: storage_id.to_string(),
                mimeType: mime_type.map(String::from),
                fileName: file_name.map(String::from),
                fileSize: Some(final_size as f64),
                width,
                height,
                duration,
            })
            .await,
    )?;

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

/// Helper to mark a media record as failed without propagating errors.
async fn mark_media_failed(ctx: &TaskExecutionContext, external_id: &str, error: &str) {
    if let Err(e) = ctx
        .client
        .clone()
        .media_mark_failed(MediaMarkFailedArgs {
            externalId: external_id.to_string(),
            error: error.to_string(),
        })
        .await
    {
        warn!(external_id, error = %e, "Failed to mark media as failed");
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Map a `MediaKind` (from messanger-interface) to its default MIME type.
fn default_mime_for_kind(kind: messanger_interface::media::MediaKind) -> &'static str {
    use messanger_interface::media::MediaKind;
    match kind {
        MediaKind::Photo => "image/jpeg",
        MediaKind::Video => "video/mp4",
        MediaKind::VideoNote => "video/mp4",
        MediaKind::Audio => "audio/mpeg",
        MediaKind::Voice => "audio/ogg",
        MediaKind::Sticker => "image/webp",
        MediaKind::Animation => "video/mp4",
        MediaKind::Document => "application/octet-stream",
    }
}

/// Map a pending record's kind (from convex-typegen) to its default MIME type.
fn default_mime_for_pending_kind(kind: &MediaListPendingForClientReturnKind) -> &'static str {
    match kind {
        MediaListPendingForClientReturnKind::Photo => "image/jpeg",
        MediaListPendingForClientReturnKind::Video => "video/mp4",
        MediaListPendingForClientReturnKind::VideoNote => "video/mp4",
        MediaListPendingForClientReturnKind::Audio => "audio/mpeg",
        MediaListPendingForClientReturnKind::Voice => "audio/ogg",
        MediaListPendingForClientReturnKind::Sticker => "image/webp",
        MediaListPendingForClientReturnKind::Animation => "video/mp4",
        MediaListPendingForClientReturnKind::Document => "application/octet-stream",
    }
}

/// Parse a media external ID ("media:{chat_id}:{msg_id}") into its components.
fn parse_media_external_id(external_id: &str) -> Option<(String, i32)> {
    let parts: Vec<&str> = external_id.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let chat_ext_id = parts[1].to_string();
    let msg_id: i32 = parts[2].parse().ok()?;
    Some((chat_ext_id, msg_id))
}

/// Set the scan phase on all scan-enabled chats for a client.
async fn set_scan_phase_for_client(
    ctx: &TaskExecutionContext,
    client: &Client,
    phase: ChatsUpdateSyncProgressScanPhase,
) {
    let chats = match ctx
        .client
        .clone()
        .query_chats_list_for_robot(ChatsListForRobotArgs {
            clientId: client.id.clone(),
        })
        .await
    {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "Failed to query chats for phase update");
            return;
        }
    };

    for chat in chats.iter().filter(|c| c.scan_enabled.unwrap_or(false)) {
        let _ = ctx
            .client
            .clone()
            .chats_update_sync_progress(ChatsUpdateSyncProgressArgs {
                chatId: chat.chat_id.clone(),
                totalMessages: None,
                syncedMessages: None,
                scanPhase: Some(phase),
            })
            .await;
    }
}

/// Map a Telegram chat type string to a Convex ChatType enum.
fn map_chat_type(chat_type: Option<&str>) -> ChatsUpsertChatType {
    match chat_type {
        Some("user") => ChatsUpsertChatType::Dialog,
        _ => ChatsUpsertChatType::Group,
    }
}
