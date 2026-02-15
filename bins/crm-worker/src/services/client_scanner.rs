//! ClientScanner — Restate virtual object that orchestrates scanning for a
//! connected Telegram client.
//!
//! Keyed by `client_id`. This is a thin orchestrator: it verifies the session,
//! syncs dialogs (blocking), then dispatches all heavy work to dedicated
//! services via fire-and-forget Restate sends:
//!
//! - `DialogSync`       — sync the dialog list (called blocking)
//! - `ProfilePhotoSync` — download profile photos
//! - `ChatScanner`      — scan messages per chat (one invocation per chat)
//! - `MediaDownloader`  — download pending media files
//! - `UpdateListener`   — real-time message stream

use std::sync::Arc;
use std::time::Duration;

use convex_backend::{ChatsUpdateSyncProgressScanPhase, ConvexApiClient};
use messanger_interface::MessengerClient;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use tracing::{error, info, warn};

use crate::client_pool::ClientPool;
use crate::config;
use crate::error::WorkerError;
use crate::ops::convex as cx;

use super::ScanRequest;
use super::chat_scanner::{ChatScanRequest, ChatScannerClient};
use super::dialog_sync::DialogSyncClient;
use super::media_downloader::MediaDownloaderClient;
use super::profile_photo_sync::ProfilePhotoSyncClient;
use super::update_listener::UpdateListenerClient;

#[restate_sdk::object]
pub trait ClientScanner {
    async fn start_scan(req: Json<ScanRequest>) -> Result<(), HandlerError>;
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
        req: Json<ScanRequest>,
    ) -> Result<(), HandlerError> {
        let req = req.into_inner();
        info!(
            client_id = %req.client_id,
            external_id = %req.external_id,
            "ClientScanner: orchestrating scan"
        );

        let result = self.orchestrate(&ctx, &req).await;

        match result {
            Ok(()) => {
                info!(client_id = %req.client_id, "Scan orchestration complete");
                Ok(())
            }
            Err(e) => {
                error!(client_id = %req.client_id, error = %e, "Scan orchestration failed");
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
        info!("ClientScanner: stop_scan — stopping sub-services");
        let key = ctx.key().to_string();

        ctx.object_client::<UpdateListenerClient>(&key)
            .stop()
            .send();
        ctx.object_client::<ProfilePhotoSyncClient>(&key)
            .stop()
            .send();
        ctx.object_client::<MediaDownloaderClient>(&key)
            .stop()
            .send();

        Ok(())
    }
}

impl ClientScannerImpl {
    async fn orchestrate(
        &self,
        ctx: &ObjectContext<'_>,
        req: &ScanRequest,
    ) -> Result<(), WorkerError> {
        // Verify session file exists
        let session_path = config::get_session_path(&req.external_id, &req.user_id);
        if !session_path.exists() {
            return Err(WorkerError::SessionNotFound(format!(
                "No session file found for {}",
                req.external_id
            )));
        }

        // Build Telegram client and verify authorization
        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.external_id)
            .await?;

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

        // Phase 1: Sync dialogs (blocking — needed before dispatching other work)
        ctx.object_client::<DialogSyncClient>(&req.client_id)
            .sync(Json(req.clone()))
            .call()
            .await
            .map_err(|e| WorkerError::MutationFailed(format!("DialogSync failed: {e}")))?;

        // Start real-time listener immediately
        cx::set_scan_phase_for_client(
            &self.convex,
            &req.client_id,
            ChatsUpdateSyncProgressScanPhase::Listening,
        )
        .await;
        ctx.object_client::<UpdateListenerClient>(&req.client_id)
            .listen(Json(req.clone()))
            .send();

        // Start profile photo sync in background
        ctx.object_client::<ProfilePhotoSyncClient>(&req.client_id)
            .sync(Json(req.clone()))
            .send();

        // Dispatch per-chat message scanning
        let chats = cx::list_worker_chats(&self.convex, &req.client_id).await?;
        let scannable: Vec<_> = chats
            .iter()
            .filter(|c| c.scan_enabled.unwrap_or(false) && !c.full_scanned.unwrap_or(false))
            .collect();

        if !scannable.is_empty() {
            info!(count = scannable.len(), "Dispatching per-chat scanners");
        }

        for chat in scannable {
            let chat_ext_id = chat
                .chat_id
                .strip_prefix(&format!("{}:", req.client_id))
                .unwrap_or(&chat.chat_id)
                .to_string();

            ctx.object_client::<ChatScannerClient>(&chat.chat_id)
                .scan(Json(ChatScanRequest {
                    client_id: req.client_id.clone(),
                    user_id: req.user_id.clone(),
                    external_id: req.external_id.clone(),
                    chat_id: chat.chat_id.clone(),
                    chat_external_id: chat_ext_id,
                    is_pinned: chat.is_pinned,
                    pinned_name: chat.pinned_name.clone(),
                }))
                .send();
        }

        // Start media downloads after a delay (gives chat scanners time to create records)
        ctx.object_client::<MediaDownloaderClient>(&req.client_id)
            .download(Json(req.clone()))
            .send_after(Duration::from_secs(30));

        Ok(())
    }
}
