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
    ChatsListForRobotArgs, ChatsMarkFullScannedArgs, ChatsUpsertArgs, ChatsUpsertChatType,
    MediaListPendingForClientArgs, MediaListPendingForClientReturnKind, MediaMarkFailedArgs,
    MediaStartDownloadArgs, MediaStoreMediaArgs, MediaUpdateProgressArgs, MessagesMarkDeletedArgs,
    MessagesUpsertArgs,
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

    // Phase 2: Full message scan for scan-enabled chats
    if cancel.is_cancelled() {
        return Ok(());
    }
    full_scan_messages(ctx, client, &tg_client).await?;

    // Phase 3: Download pending media from current and previous scans
    if cancel.is_cancelled() {
        return Ok(());
    }
    download_pending_media(ctx, client, &tg_client).await?;

    // Phase 4: Listen for real-time updates (runs until cancelled)
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
                        mediaKind: msg.media_summary.as_ref().map(|s| to_upsert_media_kind(s.kind)),
                    })
                    .await,
            )?;

            msg_count += 1;
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

        // Mark as fully scanned
        check_result(
            ctx.client
                .clone()
                .chats_mark_full_scanned(ChatsMarkFullScannedArgs {
                    chatId: chat.chat_id.clone(),
                })
                .await,
        )?;

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

            // Periodically refresh the set of scan-enabled chats
            _ = refresh_interval.tick() => {
                // Skip if a backfill is already running
                if backfill_handle.as_ref().is_some_and(|h| !h.is_finished()) {
                    debug!("Backfill still running, skipping refresh");
                    continue;
                }

                match load_scan_enabled_chats(ctx, client).await {
                    Ok(new_set) => {
                        if new_set != scan_enabled_chats {
                            info!(count = new_set.len(), "Refreshed scan-enabled chats");
                            scan_enabled_chats = new_set;

                            // Spawn backfill as a separate task to avoid blocking updates
                            let bf_ctx = ctx.clone();
                            let bf_client = client.clone();
                            let bf_tg = tg_client.clone();
                            backfill_handle = Some(tokio::spawn(async move {
                                if let Err(e) = full_scan_messages(&bf_ctx, &bf_client, &bf_tg).await {
                                    warn!(error = %e, "Failed to backfill newly-enabled chats");
                                }
                                if let Err(e) = download_pending_media(&bf_ctx, &bf_client, &bf_tg).await {
                                    warn!(error = %e, "Failed to download pending media after backfill");
                                }
                            }));
                        }
                    }
                    Err(e) => warn!(error = %e, "Failed to refresh scan-enabled chats"),
                }
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
                        mediaKind: msg.media_summary.as_ref().map(|s| to_upsert_media_kind(s.kind)),
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
#[instrument(skip(ctx, tg_client), fields(client_id = %client.id))]
async fn download_pending_media(
    ctx: &TaskExecutionContext,
    client: &Client,
    tg_client: &Arc<TelegramClient>,
) -> Result<(), TaskError> {
    let pending = ctx
        .client
        .clone()
        .query_media_list_pending_for_client(MediaListPendingForClientArgs {
            clientId: client.id.clone(),
        })
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to query pending media: {e}")))?;

    if pending.is_empty() {
        info!("No pending media to download");
        return Ok(());
    }

    info!(count = pending.len(), "Downloading pending media");

    let mut success = 0u32;
    let mut failed = 0u32;

    for record in &pending {
        // Parse externalId format: "media:{chat_id}:{msg_id}"
        let (chat_ext_id, msg_id) = match parse_media_external_id(&record.external_id) {
            Some(parsed) => parsed,
            None => {
                warn!(external_id = %record.external_id, "Invalid media external ID format");
                mark_media_failed(ctx, &record.external_id, "Invalid external ID format").await;
                failed += 1;
                continue;
            }
        };

        // Download from Telegram and upload to Convex
        let content_type = default_mime_for_pending_kind(&record.kind);
        match download_and_upload(
            ctx,
            tg_client,
            &chat_ext_id,
            msg_id,
            &record.external_id,
            content_type,
            None, // mime_type — will be inferred from content_type
            None, // file_name
            None, // width
            None, // height
            None, // duration
        )
        .await
        {
            Ok(()) => success += 1,
            Err(e) => {
                warn!(external_id = %record.external_id, error = %e, "Failed to upload media");
                mark_media_failed(ctx, &record.external_id, &e.to_string()).await;
                failed += 1;
            }
        }

        // Rate-limit to avoid hitting Telegram download limits
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    info!(success, failed, "Pending media download complete");
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
    )
    .await
}

/// Stream-download from Telegram and pipe directly to Convex storage upload.
///
/// Uses an `mpsc` channel to bridge the download iterator (which holds the
/// Telegram client lock) with reqwest's streaming body — the file never
/// sits fully in memory.  Progress is reported to Convex every ~2s via a
/// spawned reporter task backed by an `AtomicUsize` byte counter.
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
) -> Result<(), TaskError> {
    // Step 0: Transition the media record to "downloading" status
    let _ = ctx
        .client
        .clone()
        .media_start_download(MediaStartDownloadArgs {
            externalId: external_id.to_string(),
        })
        .await;

    // Step 1: Get a presigned upload URL from Convex (before locking Telegram client)
    let upload_url = ctx
        .client
        .clone()
        .media_generate_upload_url()
        .await
        .map_err(|e| TaskError::MutationFailed(format!("Failed to generate upload URL: {e}")))?;

    // Step 2: Set up a channel to stream download chunks into the upload body,
    // with an atomic byte counter for progress tracking
    let bytes_counter = Arc::new(AtomicUsize::new(0));
    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(4);

    let counter_for_stream = bytes_counter.clone();
    let stream = tokio_stream::wrappers::ReceiverStream::new(chunk_rx).map(move |chunk| {
        if let Ok(ref data) = chunk {
            counter_for_stream.fetch_add(data.len(), Ordering::Relaxed);
        }
        chunk
    });
    let body = reqwest::Body::wrap_stream(stream);

    // Step 2b: Spawn a progress reporter that reads the counter every ~2s
    let progress_ctx = ctx.clone();
    let progress_ext_id = external_id.to_string();
    let progress_counter = bytes_counter.clone();
    let progress_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        interval.tick().await; // consume immediate first tick
        loop {
            interval.tick().await;
            let current = progress_counter.load(Ordering::Relaxed);
            let _ = progress_ctx
                .client
                .clone()
                .media_update_progress(MediaUpdateProgressArgs {
                    externalId: progress_ext_id.clone(),
                    bytesDownloaded: current as f64,
                })
                .await;
        }
    });

    // Step 3: Spawn the download task (holds Telegram client lock while streaming)
    let tg = tg_client.clone();
    let chat_ext = chat_external_id.to_string();
    let download_handle = tokio::spawn(async move {
        tg.stream_message_media(&chat_ext, msg_id, chunk_tx).await
    });

    // Step 4: Upload the streaming body to Convex storage with correct Content-Type
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

    // Step 5: Wait for the download task to finish and get the total size
    let total_bytes = download_handle
        .await
        .map_err(|e| {
            progress_handle.abort();
            TaskError::MutationFailed(format!("Download task panicked: {e}"))
        })?
        .map_err(|e| {
            progress_handle.abort();
            TaskError::MutationFailed(format!("Failed to download from Telegram: {e}"))
        })?
        .ok_or_else(|| {
            progress_handle.abort();
            TaskError::MutationFailed("No media in Telegram message".to_string())
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

    let storage_id = upload_result["storageId"]
        .as_str()
        .ok_or_else(|| TaskError::MutationFailed("Missing storageId in upload response".to_string()))?;

    // Step 6: Update the media record in Convex with the storageId + metadata
    check_result(
        ctx.client
            .clone()
            .media_store_media(MediaStoreMediaArgs {
                externalId: external_id.to_string(),
                storageId: storage_id.to_string(),
                mimeType: mime_type.map(String::from),
                fileName: file_name.map(String::from),
                fileSize: Some(total_bytes as f64),
                width,
                height,
                duration,
            })
            .await,
    )?;

    info!(external_id, storage_id, total_bytes, content_type, "Media streamed to Convex storage");
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

/// Map a Telegram chat type string to a Convex ChatType enum.
fn map_chat_type(chat_type: Option<&str>) -> ChatsUpsertChatType {
    match chat_type {
        Some("user") => ChatsUpsertChatType::Dialog,
        _ => ChatsUpsertChatType::Group,
    }
}
