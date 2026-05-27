//! PhoneAuthJob — drive the SMS-code Telegram login flow for a single
//! `phoneAuths` row.
//!
//! Trigger: `phoneAuth.pendingWork` entry (any non-terminal step).
//! The job runs until the row reaches `Connected`, `Failed`, or `Cancelled`,
//! at which point the runner drops it from the pending set and aborts the
//! task (if still alive).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use convex_backend::{
    ConvexApi, ConvexApiClient, PhoneAuthGetForWorkerArgs, PhoneAuthWorkerCompleteSendCodeArgs,
    PhoneAuthWorkerCompleteSendCodeResult, PhoneAuthWorkerCompleteVerifyCodeArgs,
    PhoneAuthWorkerCompleteVerifyCodeResult, PhoneAuthWorkerCompleteVerifyPasswordArgs,
    PhoneAuthWorkerCompleteVerifyPasswordResult, PhoneAuthsTable,
};
use futures::{StreamExt, stream::BoxStream};
use grammers_tl_types as tl;
use messanger_interface::MessengerClient;
use messanger_telegram::{
    CheckPasswordResult, ClonableLoginToken, ClonablePasswordToken, SignInResult,
};
use tracing::{error, info, warn};

use crate::job::{Job, JobCtx};
use crate::ops::convex::ConvexResultExt as _;
use crate::session_manager::SessionManager as _;

pub struct PhoneAuthJob;

#[async_trait]
impl Job for PhoneAuthJob {
    fn name(&self) -> &'static str {
        "PhoneAuth"
    }

    async fn subscribe(&self, ctx: &JobCtx) -> anyhow::Result<BoxStream<'static, Vec<String>>> {
        let sub = ctx.convex.subscribe_phone_auth_pending_work().await?;
        Ok(sub
            .filter_map(|res| async move {
                match res {
                    Ok(items) => Some(items),
                    Err(e) => {
                        warn!(error = %e, "phoneAuth.pendingWork subscription error");
                        None
                    }
                }
            })
            .boxed())
    }

    async fn run_one(&self, ctx: Arc<JobCtx>, auth_id: String) -> anyhow::Result<()> {
        let auth = fetch_auth(&ctx.convex, &auth_id).await?;

        let tg = ctx
            .sessions
            .get_or_create_for_phone(&auth.user_id, &auth.phone)
            .await?;

        if let Ok(true) = tg.is_authorized().await {
            info!("client already authorized");
            ctx.convex
                .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                    authId: auth_id.clone(),
                    result: PhoneAuthWorkerCompleteSendCodeResult::AlreadyAuthorized,
                })
                .await
                .check()?;
            return Ok(());
        }

        // Step 1: request login code.
        let phone_code_hash =
            match tokio::time::timeout(Duration::from_secs(30), tg.request_login_code(&auth.phone))
                .await
            {
                Err(_) => {
                    let msg = "timeout requesting login code";
                    error!(msg);
                    ctx.convex
                        .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                            authId: auth_id,
                            result: PhoneAuthWorkerCompleteSendCodeResult::Failed {
                                error: msg.into(),
                            },
                        })
                        .await
                        .warn_on_err("report send-code timeout");
                    return Ok(());
                }
                Ok(Err(e)) => {
                    let msg = format!("request login code: {e}");
                    error!(%msg);
                    ctx.convex
                        .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                            authId: auth_id,
                            result: PhoneAuthWorkerCompleteSendCodeResult::Failed { error: msg },
                        })
                        .await
                        .warn_on_err("report send-code failure");
                    return Ok(());
                }
                Ok(Ok(token)) => {
                    info!("login code sent");
                    ctx.convex
                        .phone_auth_worker_complete_send_code(PhoneAuthWorkerCompleteSendCodeArgs {
                            authId: auth_id.clone(),
                            result: PhoneAuthWorkerCompleteSendCodeResult::Success {
                                phoneCodeHash: token.phone_code_hash.clone(),
                            },
                        })
                        .await
                        .check()?;
                    token.phone_code_hash
                }
            };

        // Step 2: wait for user to submit the code.
        let Some(code_auth) = wait_for_step(&ctx.convex, &auth_id, "VerifyingCode").await? else {
            info!("cancelled while waiting for code");
            return Ok(());
        };
        info!("received login code");

        let login_code = code_auth.login_code.unwrap_or_default();
        let clonable_token = ClonableLoginToken {
            phone: auth.phone.clone(),
            phone_code_hash,
        };

        let sign_in_result = tokio::time::timeout(
            Duration::from_secs(30),
            tg.sign_in(&clonable_token, &login_code),
        )
        .await;

        match sign_in_result {
            Err(_) => {
                let msg = "timeout verifying login code";
                error!(msg);
                ctx.convex
                    .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                        authId: auth_id,
                        result: PhoneAuthWorkerCompleteVerifyCodeResult::Failed {
                            error: msg.into(),
                        },
                    })
                    .await
                    .warn_on_err("report verify-code timeout");
                return Ok(());
            }
            Ok(Err(e)) => {
                let msg = format!("verify code: {e}");
                error!(%msg);
                ctx.convex
                    .phone_auth_worker_complete_verify_code(PhoneAuthWorkerCompleteVerifyCodeArgs {
                        authId: auth_id,
                        result: PhoneAuthWorkerCompleteVerifyCodeResult::Failed { error: msg },
                    })
                    .await
                    .warn_on_err("report verify-code failure");
                return Ok(());
            }
            Ok(Ok(result)) => match result {
                SignInResult::Success { user_id } => {
                    info!(user_id, "sign in successful");
                    ctx.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id,
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::Success {
                                    userId: user_id,
                                },
                            },
                        )
                        .await
                        .check()?;
                    return Ok(());
                }
                SignInResult::InvalidCode => {
                    warn!("invalid login code");
                    ctx.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id,
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::InvalidCode,
                            },
                        )
                        .await
                        .warn_on_err("report invalid code");
                    return Ok(());
                }
                SignInResult::SignUpRequired => {
                    warn!("sign up required");
                    ctx.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id,
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::SignUpRequired,
                            },
                        )
                        .await
                        .warn_on_err("report sign-up required");
                    return Ok(());
                }
                SignInResult::PasswordRequired(password_token) => {
                    info!("2FA password required");
                    let token_json = serde_json::to_string(&password_token.password_data)?;
                    ctx.convex
                        .phone_auth_worker_complete_verify_code(
                            PhoneAuthWorkerCompleteVerifyCodeArgs {
                                authId: auth_id.clone(),
                                result: PhoneAuthWorkerCompleteVerifyCodeResult::PasswordRequired {
                                    hint: password_token.hint.clone(),
                                    passwordToken: token_json,
                                },
                            },
                        )
                        .await
                        .check()?;
                    // fall through to password step
                }
            },
        }

        // Step 3: wait for user to submit password.
        let Some(pw_auth) = wait_for_step(&ctx.convex, &auth_id, "VerifyingPassword").await? else {
            info!("cancelled while waiting for password");
            return Ok(());
        };
        info!("received password");

        let pw_token = pw_auth.password_token.unwrap_or_default();
        let pw_value = pw_auth.password.unwrap_or_default();
        let password_data: tl::types::account::Password = serde_json::from_str(&pw_token)?;
        let clonable_pw_token = ClonablePasswordToken {
            hint: None,
            password_data,
        };

        let check_result = tokio::time::timeout(
            Duration::from_secs(30),
            tg.check_password(clonable_pw_token, &pw_value),
        )
        .await;

        match check_result {
            Err(_) => {
                let msg = "timeout verifying password";
                error!(msg);
                ctx.convex
                    .phone_auth_worker_complete_verify_password(
                        PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: auth_id,
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::Failed {
                                error: msg.into(),
                            },
                        },
                    )
                    .await
                    .warn_on_err("report verify-password timeout");
            }
            Ok(Err(e)) => {
                let msg = format!("verify password: {e}");
                error!(%msg);
                ctx.convex
                    .phone_auth_worker_complete_verify_password(
                        PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: auth_id,
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::Failed {
                                error: msg,
                            },
                        },
                    )
                    .await
                    .warn_on_err("report verify-password failure");
            }
            Ok(Ok(CheckPasswordResult::Success { user_id })) => {
                info!(user_id, "password verified");
                ctx.convex
                    .phone_auth_worker_complete_verify_password(
                        PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: auth_id,
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::Success {
                                userId: user_id,
                            },
                        },
                    )
                    .await
                    .check()?;
            }
            Ok(Ok(CheckPasswordResult::InvalidPassword)) => {
                warn!("invalid password");
                ctx.convex
                    .phone_auth_worker_complete_verify_password(
                        PhoneAuthWorkerCompleteVerifyPasswordArgs {
                            authId: auth_id,
                            result: PhoneAuthWorkerCompleteVerifyPasswordResult::InvalidPassword,
                        },
                    )
                    .await
                    .warn_on_err("report invalid password");
            }
        }

        Ok(())
    }
}

async fn fetch_auth(convex: &ConvexApiClient, auth_id: &str) -> anyhow::Result<PhoneAuthsTable> {
    convex
        .query_phone_auth_get_for_worker(PhoneAuthGetForWorkerArgs {
            authId: auth_id.into(),
        })
        .await?
        .ok_or_else(|| anyhow::anyhow!("phoneAuth {auth_id} not found"))
}

/// Subscribe to the phoneAuth row and wait for it to reach the target step.
/// Returns `Some(auth)` when reached, or `None` on terminal step / deletion.
async fn wait_for_step(
    convex: &ConvexApiClient,
    auth_id: &str,
    target_step: &str,
) -> anyhow::Result<Option<PhoneAuthsTable>> {
    let mut stream = convex
        .subscribe_phone_auth_get_for_worker(PhoneAuthGetForWorkerArgs {
            authId: auth_id.into(),
        })
        .await?;

    while let Some(update) = stream.next().await {
        match update {
            Ok(Some(auth)) => {
                let step_str = step_to_str(&auth.step);
                if step_str == target_step {
                    return Ok(Some(auth));
                }
                if step_str == "Cancelled" || step_str == "Failed" || step_str == "Connected" {
                    return Ok(None);
                }
            }
            Ok(None) => return Ok(None),
            Err(e) => warn!(auth_id, error = %e, "wait_for_step transient error"),
        }
    }
    anyhow::bail!("phoneAuth subscription stream ended unexpectedly");
}

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
