//! PhoneAuthWorkflow — Restate durable workflow for phone-based Telegram auth.
//!
//! The workflow key is the phone auth document ID. The workflow subscribes to
//! the phoneAuths row in Convex to detect step transitions. The frontend writes
//! codes/passwords to the phoneAuths row, and the worker detects the change via
//! subscription.
//!
//! Domain-driven: the phoneAuth record IS the state.
//! Cancellation is handled via the phoneAuth step becoming terminal (Cancelled/Failed).

use std::sync::Arc;
use std::time::Duration;

use convex_backend::{
    ConvexApi, ConvexApiClient, PhoneAuthGetForWorkerArgs, PhoneAuthWorkerCompleteSendCodeArgs,
    PhoneAuthWorkerCompleteSendCodeResult, PhoneAuthWorkerCompleteVerifyCodeArgs,
    PhoneAuthWorkerCompleteVerifyCodeResult, PhoneAuthWorkerCompleteVerifyPasswordArgs,
    PhoneAuthWorkerCompleteVerifyPasswordResult, PhoneAuthsTable,
};
use futures::StreamExt;
use grammers_tl_types as tl;
use messanger_interface::MessengerClient;
use messanger_telegram::{
    CheckPasswordResult, ClonableLoginToken, ClonablePasswordToken, SignInResult,
};
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::ops::convex::{ConvexResultExt as _, EntityRequest};
use crate::session_manager::{SessionManager as _, TelegramSessionManager};

// ────────────────────────────────────────────────────────────────────────────
// Result type
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct PhoneAuthResult {
    pub success: bool,
    pub error: Option<String>,
}

// ────────────────────────────────────────────────────────────────────────────
// Workflow definition
// ────────────────────────────────────────────────────────────────────────────

#[restate_sdk::workflow]
pub trait PhoneAuthWorkflow {
    async fn run(req: Json<EntityRequest>) -> Result<Json<PhoneAuthResult>, HandlerError>;
}

pub struct PhoneAuthWorkflowImpl {
    pub convex: ConvexApiClient,
    pub sessions: Arc<TelegramSessionManager>,
}

impl PhoneAuthWorkflow for PhoneAuthWorkflowImpl {
    async fn run(
        &self,
        _ctx: WorkflowContext<'_>,
        req: Json<EntityRequest>,
    ) -> Result<Json<PhoneAuthResult>, HandlerError> {
        let auth_id = req.into_inner().entity_id;
        info!(auth_id = %auth_id, "PhoneAuthWorkflow started");
        self.run_inner(&auth_id).await
    }
}

impl PhoneAuthWorkflowImpl {
    async fn run_inner(&self, auth_id: &str) -> Result<Json<PhoneAuthResult>, HandlerError> {
        // Use the phoneAuth subscription itself for cancellation detection
        // (terminal steps: Cancelled, Failed, Connected)
        let cancel_token = CancellationToken::new();

        // Fetch the full phoneAuth record
        let auth = self.fetch_auth(auth_id).await?;

        // Get or create Telegram client
        let tg_client = self
            .sessions
            .get_or_create_for_phone(&auth.user_id, &auth.phone)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        // Check if already authorized
        if let Ok(true) = tg_client.is_authorized().await {
            info!(auth_id = %auth_id, "Client already authorized");
            self.convex
                .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                    authId: auth_id.to_string(),
                    result: PhoneAuthWorkerCompleteSendCodeResult::AlreadyAuthorized,
                })
                .await
                .check()
                .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
            return Ok(Json(PhoneAuthResult {
                success: true,
                error: None,
            }));
        }

        // Request login code
        let code_result = tokio::time::timeout(
            Duration::from_secs(30),
            tg_client.request_login_code(&auth.phone),
        )
        .await;

        let phone_code_hash = match code_result {
            Err(_) => {
                let msg = "Timeout requesting login code";
                error!(msg);
                self.convex
                    .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                        authId: auth_id.to_string(),
                        result: PhoneAuthWorkerCompleteSendCodeResult::Failed {
                            error: msg.to_string(),
                        },
                    })
                    .await
                    .warn_on_err("Failed to report send-code timeout");
                return Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg.to_string()),
                }));
            }
            Ok(Err(e)) => {
                let msg = format!("Failed to request login code: {e}");
                error!(%msg);
                self.convex
                    .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                        authId: auth_id.to_string(),
                        result: PhoneAuthWorkerCompleteSendCodeResult::Failed {
                            error: msg.clone(),
                        },
                    })
                    .await
                    .warn_on_err("Failed to report send-code failure");
                return Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg),
                }));
            }
            Ok(Ok(token)) => {
                info!(auth_id = %auth_id, "Login code sent successfully");
                self.convex
                    .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                        authId: auth_id.to_string(),
                        result: PhoneAuthWorkerCompleteSendCodeResult::Success {
                            phoneCodeHash: token.phone_code_hash.clone(),
                        },
                    })
                    .await
                    .check()
                    .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                token.phone_code_hash
            }
        };

        // Wait for user to submit the code
        let code_auth = self
            .wait_for_step(auth_id, "VerifyingCode", &cancel_token)
            .await?;

        let Some(code_auth) = code_auth else {
            info!(auth_id = %auth_id, "PhoneAuth cancelled while waiting for code");
            return Ok(Json(PhoneAuthResult {
                success: false,
                error: Some("Cancelled".to_string()),
            }));
        };

        info!(auth_id = %auth_id, "Received login code from user");

        // Verify the code
        let login_code = code_auth.login_code.unwrap_or_default();
        let clonable_token = ClonableLoginToken {
            phone: auth.phone.clone(),
            phone_code_hash,
        };

        let sign_in_result = tokio::time::timeout(
            Duration::from_secs(30),
            tg_client.sign_in(&clonable_token, &login_code),
        )
        .await;

        match sign_in_result {
            Err(_) => {
                let msg = "Timeout verifying login code";
                error!(msg);
                self.convex
                    .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                        authId: auth_id.to_string(),
                        result: PhoneAuthWorkerCompleteVerifyCodeResult::Failed {
                            error: msg.to_string(),
                        },
                    })
                    .await
                    .warn_on_err("Failed to report verify-code timeout");
                return Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg.to_string()),
                }));
            }
            Ok(Err(e)) => {
                let msg = format!("Failed to verify code: {e}");
                error!(%msg);
                self.convex
                    .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                        authId: auth_id.to_string(),
                        result: PhoneAuthWorkerCompleteVerifyCodeResult::Failed {
                            error: msg.clone(),
                        },
                    })
                    .await
                    .warn_on_err("Failed to report verify-code failure");
                return Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg),
                }));
            }
            Ok(Ok(result)) => match result {
                SignInResult::Success { user_id } => {
                    info!(auth_id = %auth_id, user_id, "Sign in successful");
                    self.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id.to_string(),
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::Success {
                                    userId: user_id,
                                },
                            },
                        )
                        .await
                        .check()
                        .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                    return Ok(Json(PhoneAuthResult {
                        success: true,
                        error: None,
                    }));
                }
                SignInResult::InvalidCode => {
                    warn!(auth_id = %auth_id, "Invalid login code");
                    self.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id.to_string(),
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::InvalidCode,
                            },
                        )
                        .await
                        .warn_on_err("Failed to report invalid code");
                    return Ok(Json(PhoneAuthResult {
                        success: false,
                        error: Some("Invalid code".to_string()),
                    }));
                }
                SignInResult::SignUpRequired => {
                    warn!(auth_id = %auth_id, "Sign up required");
                    self.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id.to_string(),
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::SignUpRequired,
                            },
                        )
                        .await
                        .warn_on_err("Failed to report sign-up required");
                    return Ok(Json(PhoneAuthResult {
                        success: false,
                        error: Some("Sign up required".to_string()),
                    }));
                }
                SignInResult::PasswordRequired(password_token) => {
                    info!(auth_id = %auth_id, "2FA password required");
                    let token_json = serde_json::to_string(&password_token.password_data)
                        .map_err(|e| HandlerError::from(anyhow::anyhow!("Serialization: {e}")))?;
                    self.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id.to_string(),
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::PasswordRequired {
                                    hint: password_token.hint.clone(),
                                    passwordToken: token_json,
                                },
                            },
                        )
                        .await
                        .check()
                        .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                    // Fall through to password step
                }
            },
        }

        // Wait for user to submit password
        let pw_auth = self
            .wait_for_step(auth_id, "VerifyingPassword", &cancel_token)
            .await?;

        let Some(pw_auth) = pw_auth else {
            info!(auth_id = %auth_id, "PhoneAuth cancelled while waiting for password");
            return Ok(Json(PhoneAuthResult {
                success: false,
                error: Some("Cancelled".to_string()),
            }));
        };

        info!(auth_id = %auth_id, "Received password from user");

        // Verify the password
        let pw_token = pw_auth.password_token.unwrap_or_default();
        let pw_value = pw_auth.password.unwrap_or_default();
        let password_data: tl::types::account::Password = serde_json::from_str(&pw_token)
            .map_err(|e| HandlerError::from(anyhow::anyhow!("Password token invalid: {e}")))?;

        let clonable_pw_token = ClonablePasswordToken {
            hint: None,
            password_data,
        };

        let check_result_val = tokio::time::timeout(
            Duration::from_secs(30),
            tg_client.check_password(clonable_pw_token, &pw_value),
        )
        .await;

        match check_result_val {
            Err(_) => {
                let msg = "Timeout verifying password";
                error!(msg);
                self.convex
                    .phone_auth_worker_complete_verify_password(
                        PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: auth_id.to_string(),
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::Failed {
                                error: msg.to_string(),
                            },
                        },
                    )
                    .await
                    .warn_on_err("Failed to report verify-password timeout");
                Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg.to_string()),
                }))
            }
            Ok(Err(e)) => {
                let msg = format!("Failed to verify password: {e}");
                error!(%msg);
                self.convex
                    .phone_auth_worker_complete_verify_password(
                        PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: auth_id.to_string(),
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::Failed {
                                error: msg.clone(),
                            },
                        },
                    )
                    .await
                    .warn_on_err("Failed to report verify-password failure");
                Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg),
                }))
            }
            Ok(Ok(result)) => {
                match result {
                    CheckPasswordResult::Success { user_id } => {
                        info!(auth_id = %auth_id, user_id, "Password verified");
                        self.convex
                            .phone_auth_worker_complete_verify_password(
                                PhoneAuthWorkerCompleteVerifyPasswordArgs {
                                    authId: auth_id.to_string(),
                                    result: PhoneAuthWorkerCompleteVerifyPasswordResult::Success {
                                        userId: user_id,
                                    },
                                },
                            )
                            .await
                            .check()
                            .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                        Ok(Json(PhoneAuthResult {
                            success: true,
                            error: None,
                        }))
                    }
                    CheckPasswordResult::InvalidPassword => {
                        warn!(auth_id = %auth_id, "Invalid password");
                        self.convex
                        .phone_auth_worker_complete_verify_password(PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: auth_id.to_string(),
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::InvalidPassword,
                        })
                        .await
                        .warn_on_err("Failed to report invalid password");
                        Ok(Json(PhoneAuthResult {
                            success: false,
                            error: Some("Invalid password".to_string()),
                        }))
                    }
                }
            }
        }
    }

    /// Fetch the phoneAuth record from Convex.
    async fn fetch_auth(&self, auth_id: &str) -> Result<PhoneAuthsTable, HandlerError> {
        self.convex
            .query_phone_auth_get_for_worker(PhoneAuthGetForWorkerArgs {
                authId: auth_id.to_string(),
            })
            .await
            .map_err(|e| HandlerError::from(anyhow::anyhow!("Failed to fetch phoneAuth: {e}")))?
            .ok_or_else(|| HandlerError::from(anyhow::anyhow!("phoneAuth {} not found", auth_id)))
    }

    /// Subscribe to the phoneAuths row and wait for it to reach the target step.
    ///
    /// Returns `Some(auth)` when the target step is reached, or `None` if cancelled.
    async fn wait_for_step(
        &self,
        auth_id: &str,
        target_step: &str,
        cancel_token: &CancellationToken,
    ) -> Result<Option<PhoneAuthsTable>, HandlerError> {
        let mut stream = self
            .convex
            .subscribe_phone_auth_get_for_worker(PhoneAuthGetForWorkerArgs {
                authId: auth_id.to_string(),
            })
            .await
            .map_err(|e| HandlerError::from(anyhow::anyhow!("Subscription failed: {e}")))?;

        loop {
            tokio::select! {
                biased;

                _ = cancel_token.cancelled() => {
                    return Ok(None);
                }

                update = stream.next() => {
                    match update {
                        Some(Ok(Some(auth))) => {
                            let step_str = step_to_str(&auth.step);
                            if step_str == target_step {
                                return Ok(Some(auth));
                            }
                            if step_str == "Cancelled" || step_str == "Failed" || step_str == "Connected" {
                                // Terminal step reached — abort
                                return Ok(None);
                            }
                            // Not the step we're waiting for, keep watching
                        }
                        Some(Ok(None)) => {
                            // Auth record deleted — treat as cancel
                            return Ok(None);
                        }
                        Some(Err(e)) => {
                            warn!(auth_id = %auth_id, error = %e, "Subscription error in wait_for_step");
                            // Transient errors — keep watching
                        }
                        None => {
                            // Stream ended
                            return Err(HandlerError::from(anyhow::anyhow!(
                                "phoneAuth subscription stream ended unexpectedly"
                            )));
                        }
                    }
                }
            }
        }
    }
}

/// Convert a PhoneAuthsStep enum to its string representation for comparison.
fn step_to_str(step: &convex_backend::PhoneAuthsStep) -> &'static str {
    use convex_backend::PhoneAuthsStep::*;
    match step {
        SendingCode => "SendingCode",
        WaitingCode => "WaitingCode",
        VerifyingCode => "VerifyingCode",
        WaitingPassword => "WaitingPassword",
        VerifyingPassword => "VerifyingPassword",
        Connected => "Connected",
        Failed => "Failed",
        Cancelled => "Cancelled",
    }
}
