//! DialogSync — Restate virtual object for syncing Telegram dialogs to Convex.
//!
//! Keyed by `client_id`. Iterates all Telegram dialogs and upserts them as chats.
//! Domain-driven: reads client state from Convex, transitions NeedsSync → Syncing → Listening.

use std::sync::Arc;

use convex_backend::{
    ClientsGetForWorkerArgs, ClientsWorkerCompleteSyncArgs, ClientsWorkerStartSyncArgs, ConvexApi,
    ConvexApiClient, DomainOpsUpsertChatArgs,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::TelegramClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{info, warn};

use crate::error::WorkerError;
use crate::ops::convex::{self as cx, EntityRequest};
use crate::session_manager::{SessionManager as _, TelegramSessionManager};

/// Subset of client fields used internally after reading from Convex.
#[derive(Clone)]
pub struct ClientFields {
    pub client_id: String,
    pub user_id: String,
    pub telegram_id: String,
}

#[restate_sdk::object]
pub trait DialogSync {
    async fn sync(req: Json<EntityRequest>) -> Result<(), HandlerError>;
}

pub struct DialogSyncImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl DialogSync for DialogSyncImpl {
    async fn sync(
        &self,
        _ctx: ObjectContext<'_>,
        req: Json<EntityRequest>,
    ) -> Result<(), HandlerError> {
        let client_id = req.into_inner().entity_id;

        // Query fresh domain state
        let client = self
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: client_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get client: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Client {} not found", client_id))?;

        // Idempotency guard: only process NeedsSync clients
        let phase = client.phase.as_ref().map(|p| p.to_string());
        if phase.as_deref() != Some("NeedsSync") {
            info!(client_id, ?phase, "DialogSync: not NeedsSync, skipping");
            return Ok(());
        }

        // Transition: NeedsSync → Syncing
        self.convex
            .clients_worker_start_sync(ClientsWorkerStartSyncArgs {
                clientId: client_id.clone(),
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to start sync: {e}"))?;

        info!(client_id = %client_id, "DialogSync: syncing dialogs");

        let fields = ClientFields {
            client_id: client_id.clone(),
            user_id: client.user_id,
            telegram_id: client.telegram_id,
        };

        let tg_client = self
            .sessions
            .get_for_telegram_id(&fields.user_id, &fields.telegram_id)
            .await
            .map_err(anyhow::Error::from)?;

        sync_dialogs(&self.convex, &tg_client, &fields)
            .await
            .map_err(anyhow::Error::from)?;

        // Transition: Syncing → Listening + photosSynced=false + set scanPhase=Queued
        self.convex
            .clients_worker_complete_sync(ClientsWorkerCompleteSyncArgs {
                clientId: client_id,
            })
            .await
            .map_err(|e| anyhow::anyhow!("Failed to complete sync: {e}"))?;

        Ok(())
    }
}

/// Sync all Telegram dialogs to Convex for a client.
pub async fn sync_dialogs(
    convex: &ConvexApiClient,
    tg_client: &TelegramClient,
    client: &ClientFields,
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
        let chat_id = format!("{}:{}", client.client_id, dialog.external_id);
        let chat_type = cx::map_chat_type(dialog.chat_type.as_deref());

        convex
            .domain_ops_upsert_chat(DomainOpsUpsertChatArgs {
                chatId: chat_id,
                userId: client.user_id.clone(),
                clientId: client.client_id.clone(),
                chatType: chat_type,
                isPinned: dialog.is_pinned,
                pinnedName: dialog.name.clone(),
                lastMessageTimestamp: 0.0,
            })
            .await
            .map_err(|e| WorkerError::MutationFailed(e.to_string()))?;

        count += 1;
    }

    info!(count, "Dialog sync complete");
    Ok(())
}
