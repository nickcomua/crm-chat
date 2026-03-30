//! QrAuthWorkflow — Restate durable workflow for QR-code-based Telegram auth.
//!
//! The workflow key is the qrAuth document ID. The workflow actively polls the
//! Telegram `login_with_qr()` stream, posting new token URLs back to Convex as
//! they arrive.
//!
//! Domain-driven: uses qrAuth domain mutations.
//! Cancellation is handled via a domain watcher that subscribes to the qrAuth
//! step — when it becomes terminal (Cancelled), the workflow exits.

use std::sync::Arc;
use std::time::Duration;

use convex_backend::{
    ConvexApi, ConvexApiClient, QrAuthGetForWorkerArgs, QrAuthWorkerCompleteArgs,
    QrAuthWorkerCompleteStep, QrAuthWorkerUpdateTokenArgs, QrAuthWorkerUpdateTokenStep,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::QrLoginToken;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::ops::convex::{ConvexWarnExt, EntityRequest};
use crate::ops::domain_watcher::spawn_qr_auth_watcher;
use crate::session_manager::{SessionManager as _, TelegramSessionManager};

// ────────────────────────────────────────────────────────────────────────────
// Result type
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct QrAuthResult {
    pub success: bool,
    pub error: Option<String>,
}

// ────────────────────────────────────────────────────────────────────────────
// Workflow definition
// ────────────────────────────────────────────────────────────────────────────

#[restate_sdk::workflow]
pub trait QrAuthWorkflow {
    async fn run(req: Json<EntityRequest>) -> Result<Json<QrAuthResult>, HandlerError>;
}

pub struct QrAuthWorkflowImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl QrAuthWorkflow for QrAuthWorkflowImpl {
    async fn run(
        &self,
        _ctx: WorkflowContext<'_>,
        req: Json<EntityRequest>,
    ) -> Result<Json<QrAuthResult>, HandlerError> {
        let auth_id = req.into_inner().entity_id;
        info!(auth_id = %auth_id, "QrAuthWorkflow started");
        self.run_inner(&auth_id).await
    }
}

impl QrAuthWorkflowImpl {
    async fn run_inner(&self, auth_id: &str) -> Result<Json<QrAuthResult>, HandlerError> {
        // Fetch the full qrAuth record to get userId
        let auth = self
            .convex
            .query_qr_auth_get_for_worker(QrAuthGetForWorkerArgs {
                authId: auth_id.to_string(),
            })
            .await
            .map_err(|e| HandlerError::from(anyhow::anyhow!("Failed to fetch qrAuth: {e}")))?
            .ok_or_else(|| HandlerError::from(anyhow::anyhow!("qrAuth {} not found", auth_id)))?;

        let user_id = auth.user_id.clone();

        // Idempotency guard: only process Pending
        let step_str = auth.step.to_string();
        if step_str != "Pending" {
            info!(auth_id, step = %step_str, "QrAuth: not Pending, skipping");
            return Ok(Json(QrAuthResult {
                success: false,
                error: Some(format!("Already in step: {step_str}")),
            }));
        }

        // Spawn domain cancel watcher — fires when step becomes terminal
        let cancel_token = CancellationToken::new();
        let _watcher = spawn_qr_auth_watcher(&self.convex, auth_id, cancel_token.clone());

        // Get or create Telegram client (temp session for QR auth)
        let tg_client = self
            .sessions
            .get_or_create_for_qr(&user_id, auth_id)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        // Check if already authorized
        if let Ok(true) = tg_client.is_authorized().await {
            info!(auth_id = %auth_id, "Client already authorized");
            let tg_user_id = tg_client.get_user_id().await.unwrap_or(0);
            let phone_number = tg_client.get_phone_number().await;
            self.sessions.promote_qr_session(
                &user_id,
                auth_id,
                phone_number.as_deref(),
                tg_user_id as i64,
            );

            self.convex
                .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                    authId: auth_id.to_string(),
                    step: QrAuthWorkerCompleteStep::AlreadyAuthorized,
                    telegramUserId: Some(tg_user_id as i64),
                    phoneNumber: phone_number,
                    error: None,
                })
                .await
                .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;

            self.sessions.remove_temp(&user_id, auth_id);
            return Ok(Json(QrAuthResult {
                success: true,
                error: None,
            }));
        }

        // Run QR login polling loop
        let result = self.qr_polling_loop(auth_id, &user_id, &cancel_token).await;

        // Clean up temp session from cache regardless of outcome
        self.sessions.remove_temp(&user_id, auth_id);

        result
    }

    /// Run the QR login polling loop.
    async fn qr_polling_loop(
        &self,
        auth_id: &str,
        user_id: &str,
        cancel_token: &CancellationToken,
    ) -> Result<Json<QrAuthResult>, HandlerError> {
        let tg_client = self
            .sessions
            .get_or_create_for_qr(user_id, auth_id)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        let mut stream = std::pin::pin!(tg_client.login_with_qr());
        let mut last_token_url: Option<String> = None;

        // Overall timeout for the QR login flow (5 minutes)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);

        loop {
            tokio::select! {
                biased;

                // Cancel watcher detected terminal step (e.g. user cancelled)
                _ = cancel_token.cancelled() => {
                    info!(auth_id = %auth_id, "QR login cancelled by user");
                    return Ok(Json(QrAuthResult {
                        success: false,
                        error: Some("Cancelled by user".to_string()),
                    }));
                }

                // Poll next QR token from the stream (with overall deadline)
                token_result = async { tokio::time::timeout_at(deadline, stream.next()).await } => {
                    match token_result {
                        Err(_) => {
                            let msg = "QR login timed out after 5 minutes";
                            warn!(auth_id = %auth_id, msg);
                            self.convex
                                .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                                    authId: auth_id.to_string(),
                                    step: QrAuthWorkerCompleteStep::Failed,
                                    telegramUserId: None,
                                    phoneNumber: None,
                                    error: Some(msg.to_string()),
                                })
                                .await
                                .warn_on_err("Failed to report QR timeout");
                            return Ok(Json(QrAuthResult {
                                success: false,
                                error: Some(msg.to_string()),
                            }));
                        }
                        Ok(None) => {
                            let msg = "QR login stream ended unexpectedly";
                            warn!(auth_id = %auth_id, msg);
                            self.convex
                                .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                                    authId: auth_id.to_string(),
                                    step: QrAuthWorkerCompleteStep::Failed,
                                    telegramUserId: None,
                                    phoneNumber: None,
                                    error: Some(msg.to_string()),
                                })
                                .await
                                .warn_on_err("Failed to report QR stream ended");
                            return Ok(Json(QrAuthResult {
                                success: false,
                                error: Some(msg.to_string()),
                            }));
                        }
                        Ok(Some(Err(e))) => {
                            let msg = format!("QR login error: {e}");
                            error!(auth_id = %auth_id, %msg);
                            self.convex
                                .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                                    authId: auth_id.to_string(),
                                    step: QrAuthWorkerCompleteStep::Failed,
                                    telegramUserId: None,
                                    phoneNumber: None,
                                    error: Some(msg.clone()),
                                })
                                .await
                                .warn_on_err("Failed to report QR stream error");
                            return Ok(Json(QrAuthResult {
                                success: false,
                                error: Some(msg),
                            }));
                        }
                        Ok(Some(Ok(token))) => match token {
                            QrLoginToken::Token { url, expires } => {
                                if last_token_url.as_ref() == Some(&url) {
                                    continue;
                                }
                                info!(auth_id = %auth_id, expires, "New QR token generated");
                                last_token_url = Some(url.clone());

                                self.convex
                                    .qr_auth_worker_update_token(QrAuthWorkerUpdateTokenArgs {
                                        authId: auth_id.to_string(),
                                        step: QrAuthWorkerUpdateTokenStep::Token,
                                        qrUrl: Some(url),
                                        qrExpires: Some(f64::from(expires)),
                                    })
                                    .await
                                    .warn_on_err("Failed to update QR token (transient, continuing)");
                            }
                            QrLoginToken::Success { user_id: tg_user_id } => {
                                info!(auth_id = %auth_id, tg_user_id, "QR login successful");
                                let phone_number = tg_client.get_phone_number().await;
                                self.sessions.promote_qr_session(
                                    user_id,
                                    auth_id,
                                    phone_number.as_deref(),
                                    tg_user_id,
                                );

                                self.convex
                                    .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                                        authId: auth_id.to_string(),
                                        step: QrAuthWorkerCompleteStep::Authorized,
                                        telegramUserId: Some(tg_user_id),
                                        phoneNumber: phone_number,
                                        error: None,
                                    })
                                    .await
                                    .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;

                                return Ok(Json(QrAuthResult {
                                    success: true,
                                    error: None,
                                }));
                            }
                            QrLoginToken::MigrateTo { dc_id } => {
                                info!(auth_id = %auth_id, dc_id, "DC migration in progress");
                                // Migration is handled internally by grammers, continue polling
                            }
                        },
                    }
                }
            }
        }
    }
}
