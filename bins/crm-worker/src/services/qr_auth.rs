//! QrAuthWorkflow — Restate durable workflow for QR-code-based Telegram auth.
//!
//! The workflow key is the QR auth document ID. Unlike PhoneAuthWorkflow (which
//! suspends on user-driven promises), this workflow actively polls the Telegram
//! `login_with_qr()` stream, posting new token URLs back to Convex as they
//! arrive. Cancellation is handled via a Restate promise that races the stream.

use std::sync::Arc;
use std::time::Duration;

use convex_backend::{
    ConvexApi, ConvexApiClient, QrAuthWorkerClaimArgs, QrAuthWorkerCompleteQrAuthArgs,
    QrAuthWorkerCompleteQrAuthResult, QrAuthWorkerUpdateQrTokenArgs, QrAuthsTable,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::QrLoginToken;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use crate::client_pool::ClientPool;
use crate::config;
use crate::ops::convex::{mark_task_complete, ConvexResultExt as _};

// ────────────────────────────────────────────────────────────────────────────
// Result type (serializable for Restate)
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
    async fn run(req: Json<QrAuthsTable>) -> Result<Json<QrAuthResult>, HandlerError>;
    #[shared]
    async fn cancel() -> Result<(), HandlerError>;
}

pub struct QrAuthWorkflowImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl QrAuthWorkflow for QrAuthWorkflowImpl {
    async fn run(
        &self,
        _ctx: WorkflowContext<'_>,
        req: Json<QrAuthsTable>,
    ) -> Result<Json<QrAuthResult>, HandlerError> {
        let req = req.into_inner();
        let auth_id_for_complete = req.id.clone();
        info!(auth_id = %req.id, "QrAuthWorkflow started");
        let result = self.run_inner(req).await;
        mark_task_complete(&self.convex, "QrAuth:run", &auth_id_for_complete).await;
        result
    }

    async fn cancel(&self, ctx: SharedWorkflowContext<'_>) -> Result<(), HandlerError> {
        ctx.resolve_promise::<bool>("cancel", true);
        Ok(())
    }
}

impl QrAuthWorkflowImpl {
    async fn run_inner(
        &self,
        req: QrAuthsTable,
    ) -> Result<Json<QrAuthResult>, HandlerError> {
        // Step 1: Claim the auth session
        self.convex
            .qr_auth_worker_claim(QrAuthWorkerClaimArgs {
                authId: req.id.clone(),
            })
            .await
            .check()
            .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;

        // Step 2: Get or create Telegram client (using auth_id as session identifier)
        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.id)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        // Step 3: Check if already authorized
        if let Ok(true) = tg_client.is_authorized().await {
            info!(auth_id = %req.id, "Client already authorized");
            let user_id = tg_client.get_user_id().await.unwrap_or(0);
            let phone_number = tg_client.get_phone_number().await;
            config::copy_session_for_scanning(&req.id, &req.user_id, user_id);

            self.convex
                .qr_auth_worker_complete_qr_auth(QrAuthWorkerCompleteQrAuthArgs {
                    authId: req.id.clone(),
                    result: QrAuthWorkerCompleteQrAuthResult::AlreadyAuthorized {
                        userId: user_id,
                        phoneNumber: phone_number,
                    },
                })
                .await
                .check()
                .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;

            self.pool.remove(&req.user_id, &req.id);
            return Ok(Json(QrAuthResult {
                success: true,
                error: None,
            }));
        }

        // Step 4: Run QR login polling loop
        let result = self.qr_polling_loop(&req).await;

        // Clean up client from pool regardless of outcome
        self.pool.remove(&req.user_id, &req.id);

        result
    }

    /// Run the QR login polling loop.
    ///
    /// Streams QR tokens from the Telegram client, posting each new token URL
    /// to Convex. Completes when login succeeds, fails, or is cancelled.
    async fn qr_polling_loop(&self, req: &QrAuthsTable) -> Result<Json<QrAuthResult>, HandlerError> {
        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.id)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        let mut stream = std::pin::pin!(tg_client.login_with_qr());
        let mut last_token_url: Option<String> = None;

        // Overall timeout for the QR login flow (5 minutes)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);

        loop {
            let token_result = tokio::time::timeout_at(deadline, stream.next()).await;

            match token_result {
                Err(_) => {
                    // Overall timeout expired
                    let msg = "QR login timed out after 5 minutes";
                    warn!(auth_id = %req.id, msg);
                    self.convex
                        .qr_auth_worker_complete_qr_auth(QrAuthWorkerCompleteQrAuthArgs {
                            authId: req.id.clone(),
                            result: QrAuthWorkerCompleteQrAuthResult::Failed {
                                error: msg.to_string(),
                            },
                        })
                        .await
                        .warn_on_err("Failed to report QR timeout");
                    return Ok(Json(QrAuthResult {
                        success: false,
                        error: Some(msg.to_string()),
                    }));
                }
                Ok(None) => {
                    // Stream ended unexpectedly
                    let msg = "QR login stream ended unexpectedly";
                    warn!(auth_id = %req.id, msg);
                    self.convex
                        .qr_auth_worker_complete_qr_auth(QrAuthWorkerCompleteQrAuthArgs {
                            authId: req.id.clone(),
                            result: QrAuthWorkerCompleteQrAuthResult::Failed {
                                error: msg.to_string(),
                            },
                        })
                        .await
                        .warn_on_err("Failed to report QR stream ended");
                    return Ok(Json(QrAuthResult {
                        success: false,
                        error: Some(msg.to_string()),
                    }));
                }
                Ok(Some(Err(e))) => {
                    // Stream error
                    let msg = format!("QR login error: {e}");
                    error!(auth_id = %req.id, %msg);
                    self.convex
                        .qr_auth_worker_complete_qr_auth(QrAuthWorkerCompleteQrAuthArgs {
                            authId: req.id.clone(),
                            result: QrAuthWorkerCompleteQrAuthResult::Failed { error: msg.clone() },
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
                        // Only update Convex if the URL actually changed
                        if last_token_url.as_ref() == Some(&url) {
                            continue;
                        }
                        info!(auth_id = %req.id, expires, "New QR token generated");
                        last_token_url = Some(url.clone());

                        self.convex
                            .qr_auth_worker_update_qr_token(QrAuthWorkerUpdateQrTokenArgs {
                                authId: req.id.clone(),
                                url,
                                expires: f64::from(expires),
                            })
                            .await
                            .warn_on_err("Failed to update QR token (transient, continuing)");
                    }
                    QrLoginToken::Success { user_id } => {
                        info!(auth_id = %req.id, user_id, "QR login successful");
                        let phone_number = tg_client.get_phone_number().await;
                        config::copy_session_for_scanning(
                            &req.id,
                            &req.user_id,
                            user_id,
                        );

                        self.convex
                            .qr_auth_worker_complete_qr_auth(QrAuthWorkerCompleteQrAuthArgs {
                                authId: req.id.clone(),
                                result: QrAuthWorkerCompleteQrAuthResult::Authorized {
                                    userId: user_id,
                                    phoneNumber: phone_number,
                                },
                            })
                            .await
                            .check()
                            .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;

                        return Ok(Json(QrAuthResult {
                            success: true,
                            error: None,
                        }));
                    }
                    QrLoginToken::MigrateTo { dc_id } => {
                        info!(auth_id = %req.id, dc_id, "DC migration in progress");
                        // Migration is handled internally by grammers, continue polling
                    }
                },
            }
        }
    }
}
