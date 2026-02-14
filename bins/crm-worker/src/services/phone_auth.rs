//! PhoneAuthWorkflow — Restate durable workflow for phone-based Telegram auth.
//!
//! The workflow key is the phone auth document ID. Steps:
//! 1. `run()` claims the auth, sends login code, then suspends on a promise
//!    waiting for the user to submit the code.
//! 2. `submit_code()` (shared handler) resolves the code promise.
//! 3. If 2FA is needed, `run()` suspends again on a password promise.
//! 4. `submit_password()` (shared handler) resolves the password promise.
//! 5. `cancel()` (shared handler) resolves the cancel promise to abort the flow.

use std::sync::Arc;
use std::time::Duration;

use convex_backend::{
    ConvexApi, ConvexApiClient, PhoneAuthWorkerClaimArgs,
    PhoneAuthWorkerCompleteSendCodeArgs, PhoneAuthWorkerCompleteSendCodeResult,
    PhoneAuthWorkerCompleteVerifyCodeArgs, PhoneAuthWorkerCompleteVerifyCodeResult,
    PhoneAuthWorkerCompleteVerifyPasswordArgs, PhoneAuthWorkerCompleteVerifyPasswordResult,
};
use grammers_tl_types as tl;
use messanger_interface::MessengerClient;
use messanger_telegram::{CheckPasswordResult, ClonableLoginToken, ClonablePasswordToken, SignInResult};
use restate_sdk::prelude::*;
use restate_sdk::serde::Json;
use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use crate::client_pool::ClientPool;

// ────────────────────────────────────────────────────────────────────────────
// Request / result types (serializable for Restate)
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct PhoneAuthRequest {
    pub auth_id: String,
    pub user_id: String,
    pub phone: String,
}

#[derive(Serialize, Deserialize)]
pub struct SubmitCodeRequest {
    pub login_code: String,
    pub phone_code_hash: String,
}

#[derive(Serialize, Deserialize)]
pub struct SubmitPasswordRequest {
    pub password: String,
    pub password_token: String,
}

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
    async fn run(req: Json<PhoneAuthRequest>) -> Result<Json<PhoneAuthResult>, HandlerError>;
    #[shared]
    async fn submit_code(req: Json<SubmitCodeRequest>) -> Result<(), HandlerError>;
    #[shared]
    async fn submit_password(req: Json<SubmitPasswordRequest>) -> Result<(), HandlerError>;
    #[shared]
    async fn cancel() -> Result<(), HandlerError>;
}

pub struct PhoneAuthWorkflowImpl {
    pub convex: ConvexApiClient,
    pub pool: Arc<ClientPool>,
}

impl PhoneAuthWorkflow for PhoneAuthWorkflowImpl {
    async fn run(
        &self,
        ctx: WorkflowContext<'_>,
        req: Json<PhoneAuthRequest>,
    ) -> Result<Json<PhoneAuthResult>, HandlerError> {
        let req = req.into_inner();
        info!(auth_id = %req.auth_id, phone = %req.phone, "PhoneAuthWorkflow started");

        // Step 1: Claim the auth session
        self.convex
            .phone_auth_worker_claim(PhoneAuthWorkerClaimArgs {
                authId: req.auth_id.clone(),
            })
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;

        // Step 2: Get or create Telegram client
        let tg_client = self
            .pool
            .get_or_create(&req.user_id, &req.phone)
            .await
            .map_err(|e| HandlerError::from(anyhow::Error::from(e)))?;

        // Step 3: Check if already authorized
        if let Ok(true) = tg_client.is_authorized().await {
            info!(auth_id = %req.auth_id, "Client already authorized");
            self.convex
                .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                    authId: req.auth_id.clone(),
                    result: PhoneAuthWorkerCompleteSendCodeResult::AlreadyAuthorized,
                })
                .await
                .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
            return Ok(Json(PhoneAuthResult {
                success: true,
                error: None,
            }));
        }

        // Step 4: Request login code
        let code_result = tokio::time::timeout(
            Duration::from_secs(30),
            tg_client.request_login_code(&req.phone),
        )
        .await;

        let phone_code_hash = match code_result {
            Err(_) => {
                let msg = "Timeout requesting login code";
                error!(msg);
                self.convex
                    .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                        authId: req.auth_id.clone(),
                        result: PhoneAuthWorkerCompleteSendCodeResult::Failed {
                            error: msg.to_string(),
                        },
                    })
                    .await
                    .ok();
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
                        authId: req.auth_id.clone(),
                        result: PhoneAuthWorkerCompleteSendCodeResult::Failed { error: msg.clone() },
                    })
                    .await
                    .ok();
                return Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg),
                }));
            }
            Ok(Ok(token)) => {
                info!(auth_id = %req.auth_id, "Login code sent successfully");
                self.convex
                    .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                        authId: req.auth_id.clone(),
                        result: PhoneAuthWorkerCompleteSendCodeResult::Success {
                            phoneCodeHash: token.phone_code_hash.clone(),
                        },
                    })
                    .await
                    .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                token.phone_code_hash
            }
        };

        // Step 5: Wait for user to submit the code (durable promise)
        // The Convex bridge detects the step change to VerifyingCode and calls submit_code()
        let code_data: Json<SubmitCodeRequest> = ctx.promise("code").await?;
        let code_data = code_data.into_inner();
        info!(auth_id = %req.auth_id, "Received login code from user");

        // Step 6: Verify the code
        let clonable_token = ClonableLoginToken {
            phone: req.phone.clone(),
            phone_code_hash,
        };

        let sign_in_result = tokio::time::timeout(
            Duration::from_secs(30),
            tg_client.sign_in(&clonable_token, &code_data.login_code),
        )
        .await;

        match sign_in_result {
            Err(_) => {
                let msg = "Timeout verifying login code";
                error!(msg);
                self.convex
                    .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                        authId: req.auth_id.clone(),
                        result: PhoneAuthWorkerCompleteVerifyCodeResult::Failed {
                            error: msg.to_string(),
                        },
                    })
                    .await
                    .ok();
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
                        authId: req.auth_id.clone(),
                        result: PhoneAuthWorkerCompleteVerifyCodeResult::Failed { error: msg.clone() },
                    })
                    .await
                    .ok();
                return Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg),
                }));
            }
            Ok(Ok(result)) => match result {
                SignInResult::Success { user_id } => {
                    info!(auth_id = %req.auth_id, user_id, "Sign in successful");
                    self.convex
                        .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                            authId: req.auth_id.clone(),
                            result: PhoneAuthWorkerCompleteVerifyCodeResult::Success { userId: user_id },
                        })
                        .await
                        .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                    return Ok(Json(PhoneAuthResult {
                        success: true,
                        error: None,
                    }));
                }
                SignInResult::InvalidCode => {
                    warn!(auth_id = %req.auth_id, "Invalid login code");
                    self.convex
                        .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                            authId: req.auth_id.clone(),
                            result: PhoneAuthWorkerCompleteVerifyCodeResult::InvalidCode,
                        })
                        .await
                        .ok();
                    return Ok(Json(PhoneAuthResult {
                        success: false,
                        error: Some("Invalid code".to_string()),
                    }));
                }
                SignInResult::SignUpRequired => {
                    warn!(auth_id = %req.auth_id, "Sign up required");
                    self.convex
                        .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                            authId: req.auth_id.clone(),
                            result: PhoneAuthWorkerCompleteVerifyCodeResult::SignUpRequired,
                        })
                        .await
                        .ok();
                    return Ok(Json(PhoneAuthResult {
                        success: false,
                        error: Some("Sign up required".to_string()),
                    }));
                }
                SignInResult::PasswordRequired(password_token) => {
                    info!(auth_id = %req.auth_id, "2FA password required");
                    let token_json = serde_json::to_string(&password_token.password_data)
                        .map_err(|e| HandlerError::from(anyhow::anyhow!("Serialization: {e}")))?;
                    self.convex
                        .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                            authId: req.auth_id.clone(),
                            result: PhoneAuthWorkerCompleteVerifyCodeResult::PasswordRequired {
                                hint: password_token.hint.clone(),
                                passwordToken: token_json,
                            },
                        })
                        .await
                        .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                    // Fall through to password step
                }
            },
        }

        // Step 7: Wait for user to submit password (durable promise)
        let pw_data: Json<SubmitPasswordRequest> = ctx.promise("password").await?;
        let pw_data = pw_data.into_inner();
        info!(auth_id = %req.auth_id, "Received password from user");

        // Step 8: Verify the password
        let password_data: tl::types::account::Password =
            serde_json::from_str(&pw_data.password_token)
                .map_err(|e| HandlerError::from(anyhow::anyhow!("Password token invalid: {e}")))?;

        let clonable_pw_token = ClonablePasswordToken {
            hint: None,
            password_data,
        };

        let check_result_val = tokio::time::timeout(
            Duration::from_secs(30),
            tg_client.check_password(clonable_pw_token, &pw_data.password),
        )
        .await;

        match check_result_val {
            Err(_) => {
                let msg = "Timeout verifying password";
                error!(msg);
                self.convex
                    .phone_auth_worker_complete_verify_password(PhoneAuthWorkerCompleteVerifyPasswordArgs {
                        authId: req.auth_id.clone(),
                        result: PhoneAuthWorkerCompleteVerifyPasswordResult::Failed {
                            error: msg.to_string(),
                        },
                    })
                    .await
                    .ok();
                Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg.to_string()),
                }))
            }
            Ok(Err(e)) => {
                let msg = format!("Failed to verify password: {e}");
                error!(%msg);
                self.convex
                    .phone_auth_worker_complete_verify_password(PhoneAuthWorkerCompleteVerifyPasswordArgs {
                        authId: req.auth_id.clone(),
                        result: PhoneAuthWorkerCompleteVerifyPasswordResult::Failed { error: msg.clone() },
                    })
                    .await
                    .ok();
                Ok(Json(PhoneAuthResult {
                    success: false,
                    error: Some(msg),
                }))
            }
            Ok(Ok(result)) => match result {
                CheckPasswordResult::Success { user_id } => {
                    info!(auth_id = %req.auth_id, user_id, "Password verified");
                    self.convex
                        .phone_auth_worker_complete_verify_password(PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: req.auth_id.clone(),
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::Success { userId: user_id },
                        })
                        .await
                        .map_err(|e| HandlerError::from(anyhow::Error::msg(e.to_string())))?;
                    Ok(Json(PhoneAuthResult {
                        success: true,
                        error: None,
                    }))
                }
                CheckPasswordResult::InvalidPassword => {
                    warn!(auth_id = %req.auth_id, "Invalid password");
                    self.convex
                        .phone_auth_worker_complete_verify_password(PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: req.auth_id.clone(),
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::InvalidPassword,
                        })
                        .await
                        .ok();
                    Ok(Json(PhoneAuthResult {
                        success: false,
                        error: Some("Invalid password".to_string()),
                    }))
                }
            },
        }
    }

    async fn submit_code(
        &self,
        ctx: SharedWorkflowContext<'_>,
        req: Json<SubmitCodeRequest>,
    ) -> Result<(), HandlerError> {
        ctx.resolve_promise::<Json<SubmitCodeRequest>>("code", req);
        Ok(())
    }

    async fn submit_password(
        &self,
        ctx: SharedWorkflowContext<'_>,
        req: Json<SubmitPasswordRequest>,
    ) -> Result<(), HandlerError> {
        ctx.resolve_promise::<Json<SubmitPasswordRequest>>("password", req);
        Ok(())
    }

    async fn cancel(&self, ctx: SharedWorkflowContext<'_>) -> Result<(), HandlerError> {
        // Resolve both promises with empty data to unblock the workflow,
        // which will then exit cleanly.
        ctx.resolve_promise::<Json<SubmitCodeRequest>>(
            "code",
            Json(SubmitCodeRequest {
                login_code: String::new(),
                phone_code_hash: String::new(),
            }),
        );
        ctx.resolve_promise::<Json<SubmitPasswordRequest>>(
            "password",
            Json(SubmitPasswordRequest {
                password: String::new(),
                password_token: String::new(),
            }),
        );
        Ok(())
    }
}
