//! Domain cancel watcher — subscribes to a domain entity's state and fires a
//! `CancellationToken` when a cancellation condition is met.
//!
//! Each entity type has its own watcher that subscribes to a lightweight query.
//! Each entity type has its own watcher function:
//! - QR auth: cancel when step becomes terminal (Authorized/AlreadyAuthorized/Failed/Cancelled)
//! - Phone auth: cancel when step becomes terminal (Connected/Failed/Cancelled)
//! - Client phase: cancel when phase becomes Disconnected
//! - Chat scan phase: cancel when scanPhase leaves Queued/ScanningMessages
//! - Media status: cancel when status becomes Skipped

use convex_backend::{
    ChatsGetScanPhaseArgs, ChatsGetScanPhaseReturn, ClientsGetPhaseArgs, ClientsGetPhaseReturn,
    ConvexApi, ConvexApiClient, MediaGetStatusArgs, MediaGetStatusReturn, QrAuthGetStepArgs,
    QrAuthGetStepReturn,
};
use futures::StreamExt;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

/// Spawn a QR auth cancel watcher. Cancels when step is terminal.
pub fn spawn_qr_auth_watcher(
    convex: &ConvexApiClient,
    auth_id: &str,
    token: CancellationToken,
) -> JoinHandle<()> {
    let convex = convex.clone();
    let auth_id = auth_id.to_string();

    tokio::spawn(async move {
        let mut stream = match convex
            .subscribe_qr_auth_get_step(QrAuthGetStepArgs {
                authId: auth_id.clone(),
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                warn!(auth_id = %auth_id, error = %e, "qr_auth_watcher: subscription failed");
                return;
            }
        };

        while let Some(result) = stream.next().await {
            match result {
                Ok(Some(step)) => {
                    if matches!(
                        step,
                        QrAuthGetStepReturn::Authorized
                            | QrAuthGetStepReturn::AlreadyAuthorized
                            | QrAuthGetStepReturn::Failed
                            | QrAuthGetStepReturn::Cancelled
                    ) {
                        debug!(auth_id = %auth_id, %step, "qr_auth_watcher: terminal step");
                        token.cancel();
                        return;
                    }
                }
                Ok(None) => {
                    debug!(auth_id = %auth_id, "qr_auth_watcher: record deleted");
                    token.cancel();
                    return;
                }
                Err(e) => {
                    warn!(auth_id = %auth_id, error = %e, "qr_auth_watcher: subscription error");
                }
            }
        }

        debug!(auth_id = %auth_id, "qr_auth_watcher: stream ended");
        token.cancel();
    })
}

/// Spawn a client phase cancel watcher. Cancels when phase becomes Disconnected
/// or the client record is deleted.
pub fn spawn_client_phase_watcher(
    convex: &ConvexApiClient,
    client_id: &str,
    token: CancellationToken,
) -> JoinHandle<()> {
    let convex = convex.clone();
    let client_id = client_id.to_string();

    tokio::spawn(async move {
        let mut stream = match convex
            .subscribe_clients_get_phase(ClientsGetPhaseArgs {
                clientId: client_id.clone(),
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                warn!(client_id = %client_id, error = %e, "client_phase_watcher: subscription failed");
                return;
            }
        };

        while let Some(result) = stream.next().await {
            match result {
                Ok(Some(phase)) => {
                    if matches!(phase, ClientsGetPhaseReturn::Disconnected) {
                        debug!(client_id = %client_id, "client_phase_watcher: disconnected");
                        token.cancel();
                        return;
                    }
                }
                Ok(None) => {
                    debug!(client_id = %client_id, "client_phase_watcher: record deleted");
                    token.cancel();
                    return;
                }
                Err(e) => {
                    warn!(client_id = %client_id, error = %e, "client_phase_watcher: subscription error");
                }
            }
        }

        debug!(client_id = %client_id, "client_phase_watcher: stream ended");
        token.cancel();
    })
}

/// Spawn a media status cancel watcher. Cancels when status becomes Skipped
/// or the record is deleted.
#[allow(dead_code)]
pub fn spawn_media_status_watcher(
    convex: &ConvexApiClient,
    media_id: &str,
    token: CancellationToken,
) -> JoinHandle<()> {
    let convex = convex.clone();
    let media_id = media_id.to_string();

    tokio::spawn(async move {
        let mut stream = match convex
            .subscribe_media_get_status(MediaGetStatusArgs {
                mediaId: media_id.clone(),
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                warn!(media_id = %media_id, error = %e, "media_status_watcher: subscription failed");
                return;
            }
        };

        while let Some(result) = stream.next().await {
            match result {
                Ok(Some(status)) => {
                    if matches!(status, MediaGetStatusReturn::Skipped) {
                        debug!(media_id = %media_id, "media_status_watcher: skipped");
                        token.cancel();
                        return;
                    }
                }
                Ok(None) => {
                    debug!(media_id = %media_id, "media_status_watcher: record deleted");
                    token.cancel();
                    return;
                }
                Err(e) => {
                    warn!(media_id = %media_id, error = %e, "media_status_watcher: subscription error");
                }
            }
        }

        debug!(media_id = %media_id, "media_status_watcher: stream ended");
        token.cancel();
    })
}

/// Spawn a chat scan phase cancel watcher. Cancels when scanPhase leaves
/// Queued/ScanningMessages/DownloadingMedia, or the record is deleted.
#[allow(dead_code)]
pub fn spawn_chat_scan_watcher(
    convex: &ConvexApiClient,
    chat_id: &str,
    token: CancellationToken,
) -> JoinHandle<()> {
    let convex = convex.clone();
    let chat_id = chat_id.to_string();

    tokio::spawn(async move {
        let mut stream = match convex
            .subscribe_chats_get_scan_phase(ChatsGetScanPhaseArgs {
                chatId: chat_id.clone(),
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                warn!(chat_id = %chat_id, error = %e, "chat_scan_watcher: subscription failed");
                return;
            }
        };

        while let Some(result) = stream.next().await {
            match result {
                Ok(Some(phase)) => {
                    // Active phases — keep watching
                    if matches!(
                        phase,
                        ChatsGetScanPhaseReturn::Queued
                            | ChatsGetScanPhaseReturn::ScanningMessages
                            | ChatsGetScanPhaseReturn::DownloadingMedia
                    ) {
                        continue;
                    }
                    // Terminal or unexpected phase — cancel
                    debug!(chat_id = %chat_id, %phase, "chat_scan_watcher: scan phase terminal");
                    token.cancel();
                    return;
                }
                Ok(None) => {
                    debug!(chat_id = %chat_id, "chat_scan_watcher: record deleted or no scan phase");
                    token.cancel();
                    return;
                }
                Err(e) => {
                    warn!(chat_id = %chat_id, error = %e, "chat_scan_watcher: subscription error");
                }
            }
        }

        debug!(chat_id = %chat_id, "chat_scan_watcher: stream ended");
        token.cancel();
    })
}
