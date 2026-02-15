//! DialogSync — Restate virtual object for syncing Telegram dialogs to Convex.
//!
//! Keyed by `client_id`. Iterates all Telegram dialogs and upserts them as chats.

use std::sync::Arc;

use convex_backend::{ChatsUpsertArgs, ConvexApi, ConvexApiClient};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{info, warn};

use crate::client_pool::ClientPool;
use crate::error::WorkerError;
use crate::ops::convex as cx;

use super::ScanRequest;

#[restate_sdk::object]
pub trait DialogSync {
    async fn sync(req: Json<ScanRequest>) -> Result<(), HandlerError>;
}

pub struct DialogSyncImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl DialogSync for DialogSyncImpl {
    async fn sync(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<ScanRequest>,
    ) -> Result<(), HandlerError> {
        let req = req.into_inner();
        info!(client_id = %req.client_id, "DialogSync: syncing dialogs");

        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.external_id)
            .await
            .map_err(anyhow::Error::from)?;

        sync_dialogs(&self.convex, &tg_client, &req)
            .await
            .map_err(anyhow::Error::from)?;
        Ok(())
    }
}

/// Sync all Telegram dialogs to Convex for a client.
pub async fn sync_dialogs(
    convex: &ConvexApiClient,
    tg_client: &TelegramClient,
    req: &ScanRequest,
) -> Result<(), WorkerError> {
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

        convex
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
