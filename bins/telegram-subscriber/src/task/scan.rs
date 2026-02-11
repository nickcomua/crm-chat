//! Chat scanning module for connected Telegram clients.
//!
//! After a client reaches "Connected" status, this module:
//! 1. Syncs Telegram dialogs to Convex (upserts chats)
//! 2. Full-scans messages for scan-enabled chats (sets fullScanned)
//! 3. Listens for real-time updates via iter_updates

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use convex_backend::{
    ChatsListForRobotArgs, ChatsMarkFullScannedArgs, ChatsUpsertArgs, ChatsUpsertChatType,
    MessagesMarkDeletedArgs, MessagesUpsertArgs,
};
use futures::StreamExt;
use messanger_interface::{MessengerClient, Update};
use messanger_telegram::TelegramClient;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, instrument, warn};

use super::TaskExecutionContext;
use crate::error::TaskError;
use crate::types::{Client, ConvexApi, check_result};

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

    // Phase 3: Listen for real-time updates (runs until cancelled)
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
    tg_client: &TelegramClient,
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

    loop {
        tokio::select! {
            biased;

            _ = cancel.cancelled() => {
                info!("Update listener cancelled");
                return Ok(());
            }

            // Periodically refresh the set of scan-enabled chats
            _ = refresh_interval.tick() => {
                match load_scan_enabled_chats(ctx, client).await {
                    Ok(new_set) => {
                        if new_set != scan_enabled_chats {
                            info!(count = new_set.len(), "Refreshed scan-enabled chats");
                            scan_enabled_chats = new_set;

                            // Backfill messages for newly-enabled chats that aren't fully scanned
                            if let Err(e) = full_scan_messages(ctx, client, tg_client).await {
                                warn!(error = %e, "Failed to backfill newly-enabled chats");
                            }
                        }
                    }
                    Err(e) => warn!(error = %e, "Failed to refresh scan-enabled chats"),
                }
            }

            update = update_stream.next() => {
                match update {
                    Some(Ok(update)) => {
                        if let Err(e) = process_update(ctx, client, &update, &scan_enabled_chats).await {
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
                        chatId: chat_id,
                        senderId: msg.sender_id.clone(),
                        text: msg.text.clone(),
                        out: msg.outgoing,
                        deleted: false,
                        ts,
                        mediaId: msg.media_external_id.clone(),
                    })
                    .await,
            )?;
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

/// Map a Telegram chat type string to a Convex ChatType enum.
fn map_chat_type(chat_type: Option<&str>) -> ChatsUpsertChatType {
    match chat_type {
        Some("user") => ChatsUpsertChatType::Dialog,
        _ => ChatsUpsertChatType::Group,
    }
}
