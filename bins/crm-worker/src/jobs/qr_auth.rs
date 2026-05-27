//! QrAuthJob — drive the QR-code Telegram login flow for a single
//! `qrAuths` row.
//!
//! Trigger: `qrAuth.pendingWork` (any non-terminal step). The job runs until
//! the row reaches Authorized/AlreadyAuthorized/Failed/Cancelled, at which
//! point the runner drops it and aborts the task.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use convex_backend::{
    ConvexApi, QrAuthGetForWorkerArgs, QrAuthWorkerCompleteArgs, QrAuthWorkerCompleteStep,
    QrAuthWorkerUpdateTokenArgs, QrAuthWorkerUpdateTokenStep,
};
use futures::{StreamExt, stream::BoxStream};
use messanger_interface::MessengerClient;
use messanger_telegram::QrLoginToken;
use tracing::{error, info, warn};

use crate::job::{Job, JobCtx};
use crate::ops::convex::ConvexWarnExt as _;
use crate::session_manager::SessionManager as _;

pub struct QrAuthJob;

#[async_trait]
impl Job for QrAuthJob {
    fn name(&self) -> &'static str {
        "QrAuth"
    }

    async fn subscribe(&self, ctx: &JobCtx) -> anyhow::Result<BoxStream<'static, Vec<String>>> {
        let sub = ctx.convex.subscribe_qr_auth_pending_work().await?;
        Ok(sub
            .filter_map(|res| async move {
                match res {
                    Ok(items) => Some(items),
                    Err(e) => {
                        warn!(error = %e, "qrAuth.pendingWork subscription error");
                        None
                    }
                }
            })
            .boxed())
    }

    async fn run_one(&self, ctx: Arc<JobCtx>, auth_id: String) -> anyhow::Result<()> {
        let auth = ctx
            .convex
            .query_qr_auth_get_for_worker(QrAuthGetForWorkerArgs {
                authId: auth_id.clone(),
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("qrAuth {auth_id} not found"))?;

        let user_id = auth.user_id.clone();

        let step_str = auth.step.to_string();
        if !matches!(step_str.as_str(), "Pending" | "Generating" | "Token") {
            info!(step = %step_str, "not an active QR auth step — skipping");
            return Ok(());
        }

        let tg = ctx
            .sessions
            .get_or_create_for_qr(&user_id, &auth_id)
            .await?;

        if let Ok(true) = tg.is_authorized().await {
            info!("client already authorized");
            let tg_user_id = tg.get_user_id().await.unwrap_or(0);
            let phone_number = tg.get_phone_number().await;
            ctx.sessions.promote_qr_session(
                &user_id,
                &auth_id,
                phone_number.as_deref(),
                tg_user_id as i64,
            );

            ctx.convex
                .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                    authId: auth_id.clone(),
                    step: QrAuthWorkerCompleteStep::AlreadyAuthorized,
                    telegramUserId: Some(tg_user_id as i64),
                    phoneNumber: phone_number,
                    error: None,
                })
                .await?;
            ctx.sessions.remove_temp(&user_id, &auth_id);
            return Ok(());
        }

        let result = qr_polling_loop(&ctx, &auth_id, &user_id).await;
        ctx.sessions.remove_temp(&user_id, &auth_id);
        result
    }
}

async fn qr_polling_loop(ctx: &JobCtx, auth_id: &str, user_id: &str) -> anyhow::Result<()> {
    let tg = ctx.sessions.get_or_create_for_qr(user_id, auth_id).await?;
    let mut stream = std::pin::pin!(tg.login_with_qr());
    let mut last_token_url: Option<String> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);

    loop {
        match tokio::time::timeout_at(deadline, stream.next()).await {
            Err(_) => {
                let msg = "QR login timed out after 5 minutes";
                warn!(msg);
                ctx.convex
                    .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                        authId: auth_id.into(),
                        step: QrAuthWorkerCompleteStep::Failed,
                        telegramUserId: None,
                        phoneNumber: None,
                        error: Some(msg.into()),
                    })
                    .await
                    .warn_on_err("report QR timeout");
                return Ok(());
            }
            Ok(None) => {
                let msg = "QR login stream ended unexpectedly";
                warn!(msg);
                ctx.convex
                    .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                        authId: auth_id.into(),
                        step: QrAuthWorkerCompleteStep::Failed,
                        telegramUserId: None,
                        phoneNumber: None,
                        error: Some(msg.into()),
                    })
                    .await
                    .warn_on_err("report QR stream ended");
                return Ok(());
            }
            Ok(Some(Err(e))) => {
                let msg = format!("QR login error: {e}");
                error!(%msg);
                ctx.convex
                    .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                        authId: auth_id.into(),
                        step: QrAuthWorkerCompleteStep::Failed,
                        telegramUserId: None,
                        phoneNumber: None,
                        error: Some(msg),
                    })
                    .await
                    .warn_on_err("report QR stream error");
                return Ok(());
            }
            Ok(Some(Ok(token))) => match token {
                QrLoginToken::Token { url, expires } => {
                    if last_token_url.as_ref() == Some(&url) {
                        continue;
                    }
                    info!(expires, "new QR token generated");
                    last_token_url = Some(url.clone());
                    ctx.convex
                        .qr_auth_worker_update_token(QrAuthWorkerUpdateTokenArgs {
                            authId: auth_id.into(),
                            step: QrAuthWorkerUpdateTokenStep::Token,
                            qrUrl: Some(url),
                            qrExpires: Some(f64::from(expires)),
                        })
                        .await
                        .warn_on_err("update QR token (transient)");
                }
                QrLoginToken::Success {
                    user_id: tg_user_id,
                } => {
                    info!(tg_user_id, "QR login successful");
                    let phone_number = tg.get_phone_number().await;
                    ctx.sessions.promote_qr_session(
                        user_id,
                        auth_id,
                        phone_number.as_deref(),
                        tg_user_id,
                    );
                    ctx.convex
                        .qr_auth_worker_complete(QrAuthWorkerCompleteArgs {
                            authId: auth_id.into(),
                            step: QrAuthWorkerCompleteStep::Authorized,
                            telegramUserId: Some(tg_user_id),
                            phoneNumber: phone_number,
                            error: None,
                        })
                        .await?;
                    return Ok(());
                }
                QrLoginToken::MigrateTo { dc_id } => {
                    info!(dc_id, "DC migration in progress");
                }
            },
        }
    }
}
