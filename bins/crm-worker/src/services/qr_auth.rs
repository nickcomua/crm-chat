//! QrAuthWorkflow — Restate durable workflow for QR-code-based Telegram auth.
//!
//! The workflow key is the worker task ID. The workflow actively polls the
//! Telegram `login_with_qr()` stream, posting new token URLs back to Convex as
//! they arrive. Cancellation is handled via a cancel watcher that subscribes
//! to the workerTask's status — when it becomes "Cancelled", the workflow exits.

use std::sync::Arc;
use std::time::Duration;

use convex_backend::{
    ConvexApi, ConvexApiClient, WorkerTasksWorkerCompleteArgs, WorkerTasksWorkerCompleteTask,
    WorkerTasksWorkerCompleteTaskQrAuthStep, WorkerTasksWorkerUpdateTaskArgs,
    WorkerTasksWorkerUpdateTaskTask, WorkerTasksWorkerUpdateTaskTaskQrAuthStep,
};
use futures::StreamExt;
use messanger_interface::MessengerClient;
use messanger_telegram::QrLoginToken;
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::client_pool::ClientPool;
use crate::config;
use crate::ops::cancel_watcher::spawn_cancel_watcher;
use crate::ops::convex::{run_task, ConvexResultExt as _};

// ────────────────────────────────────────────────────────────────────────────
// Input / result types
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct QrAuthRunRequest {
    pub task_id: String,
    pub user_id: String,
}

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
    async fn run(req: Json<QrAuthRunRequest>) -> Result<Json<QrAuthResult>, HandlerError>;
}

pub struct QrAuthWorkflowImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl QrAuthWorkflow for QrAuthWorkflowImpl {
    async fn run(
        &self,
        _ctx: WorkflowContext<'_>,
        req: Json<QrAuthRunRequest>,
    ) -> Result<Json<QrAuthResult>, HandlerError> {
        let req = req.into_inner();
        let task_id = req.task_id.clone();
        info!(task_id = %task_id, "QrAuthWorkflow started");
        self.run_inner(req).await
    }
}

impl QrAuthWorkflowImpl {
    async fn run_inner(
        &self,
        req: QrAuthRunRequest,
    ) -> Result<Json<QrAuthResult>, HandlerError> {
        // Step 1: Mark task as Running
        run_task(&self.convex, &req.task_id).await;

        // Spawn cancel watcher — fires when task status becomes "Cancelled"
        let cancel_token = CancellationToken::new();
        let _watcher = spawn_cancel_watcher(&self.convex, &req.task_id, cancel_token.clone());

        // Step 2: Get or create Telegram client (using task_id as session identifier)
        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.task_id)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        // Step 3: Check if already authorized
        if let Ok(true) = tg_client.is_authorized().await {
            info!(task_id = %req.task_id, "Client already authorized");
            let user_id = tg_client.get_user_id().await.unwrap_or(0);
            let phone_number = tg_client.get_phone_number().await;
            config::copy_session_for_scanning(&req.task_id, &req.user_id, user_id);

            self.convex
                .worker_tasks_worker_complete(WorkerTasksWorkerCompleteArgs {
                    taskId: req.task_id.clone(),
                    task: Some(WorkerTasksWorkerCompleteTask::QrAuth {
                        step: WorkerTasksWorkerCompleteTaskQrAuthStep::AlreadyAuthorized,
                        qrUrl: None,
                        qrExpires: None,
                        telegramUserId: Some(user_id as i64),
                        phoneNumber: phone_number,
                        error: None,
                    }),
                })
                .await
                .check()
                .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;

            self.pool.remove(&req.user_id, &req.task_id);
            return Ok(Json(QrAuthResult {
                success: true,
                error: None,
            }));
        }

        // Step 4: Run QR login polling loop
        let result = self.qr_polling_loop(&req, &cancel_token).await;

        // Clean up client from pool regardless of outcome
        self.pool.remove(&req.user_id, &req.task_id);

        result
    }

    /// Run the QR login polling loop.
    ///
    /// Streams QR tokens from the Telegram client, posting each new token URL
    /// to Convex. Completes when login succeeds, fails, or is cancelled.
    async fn qr_polling_loop(
        &self,
        req: &QrAuthRunRequest,
        cancel_token: &CancellationToken,
    ) -> Result<Json<QrAuthResult>, HandlerError> {
        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.task_id)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        let mut stream = std::pin::pin!(tg_client.login_with_qr());
        let mut last_token_url: Option<String> = None;

        // Overall timeout for the QR login flow (5 minutes)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);

        loop {
            tokio::select! {
                biased;

                // Cancel watcher detected task status = "Cancelled"
                _ = cancel_token.cancelled() => {
                    info!(task_id = %req.task_id, "QR login cancelled by user");
                    return Ok(Json(QrAuthResult {
                        success: false,
                        error: Some("Cancelled by user".to_string()),
                    }));
                }

                // Poll next QR token from the stream (with overall deadline)
                token_result = async { tokio::time::timeout_at(deadline, stream.next()).await } => {
                    match token_result {
                        Err(_) => {
                            // Overall timeout expired
                            let msg = "QR login timed out after 5 minutes";
                            warn!(task_id = %req.task_id, msg);
                            self.convex
                                .worker_tasks_worker_complete(WorkerTasksWorkerCompleteArgs {
                                    taskId: req.task_id.clone(),
                                    task: Some(WorkerTasksWorkerCompleteTask::QrAuth {
                                        step: WorkerTasksWorkerCompleteTaskQrAuthStep::Failed,
                                        qrUrl: None,
                                        qrExpires: None,
                                        telegramUserId: None,
                                        phoneNumber: None,
                                        error: Some(msg.to_string()),
                                    }),
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
                            warn!(task_id = %req.task_id, msg);
                            self.convex
                                .worker_tasks_worker_complete(WorkerTasksWorkerCompleteArgs {
                                    taskId: req.task_id.clone(),
                                    task: Some(WorkerTasksWorkerCompleteTask::QrAuth {
                                        step: WorkerTasksWorkerCompleteTaskQrAuthStep::Failed,
                                        qrUrl: None,
                                        qrExpires: None,
                                        telegramUserId: None,
                                        phoneNumber: None,
                                        error: Some(msg.to_string()),
                                    }),
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
                            error!(task_id = %req.task_id, %msg);
                            self.convex
                                .worker_tasks_worker_complete(WorkerTasksWorkerCompleteArgs {
                                    taskId: req.task_id.clone(),
                                    task: Some(WorkerTasksWorkerCompleteTask::QrAuth {
                                        step: WorkerTasksWorkerCompleteTaskQrAuthStep::Failed,
                                        qrUrl: None,
                                        qrExpires: None,
                                        telegramUserId: None,
                                        phoneNumber: None,
                                        error: Some(msg.clone()),
                                    }),
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
                                info!(task_id = %req.task_id, expires, "New QR token generated");
                                last_token_url = Some(url.clone());

                                self.convex
                                    .worker_tasks_worker_update_task(WorkerTasksWorkerUpdateTaskArgs {
                                        taskId: req.task_id.clone(),
                                        task: WorkerTasksWorkerUpdateTaskTask::QrAuth {
                                            step: WorkerTasksWorkerUpdateTaskTaskQrAuthStep::Token,
                                            qrUrl: Some(url),
                                            qrExpires: Some(f64::from(expires)),
                                            telegramUserId: None,
                                            phoneNumber: None,
                                            error: None,
                                        },
                                    })
                                    .await
                                    .warn_on_err("Failed to update QR token (transient, continuing)");
                            }
                            QrLoginToken::Success { user_id } => {
                                info!(task_id = %req.task_id, user_id, "QR login successful");
                                let phone_number = tg_client.get_phone_number().await;
                                config::copy_session_for_scanning(
                                    &req.task_id,
                                    &req.user_id,
                                    user_id,
                                );

                                self.convex
                                    .worker_tasks_worker_complete(WorkerTasksWorkerCompleteArgs {
                                        taskId: req.task_id.clone(),
                                        task: Some(WorkerTasksWorkerCompleteTask::QrAuth {
                                            step: WorkerTasksWorkerCompleteTaskQrAuthStep::Authorized,
                                            qrUrl: None,
                                            qrExpires: None,
                                            telegramUserId: Some(user_id),
                                            phoneNumber: phone_number,
                                            error: None,
                                        }),
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
                                info!(task_id = %req.task_id, dc_id, "DC migration in progress");
                                // Migration is handled internally by grammers, continue polling
                            }
                        },
                    }
                }
            }
        }
    }
}
