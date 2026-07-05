//! SendMessages — send user-queued outbound messages via Telegram.
//!
//! Trigger: `outgoingMessages.pendingWork` entries (service = "SendMessage").
use std::sync::Arc;

use async_trait::async_trait;
use convex_backend::{
    ClientsGetForWorkerArgs, ConvexApi, MessagesWorkerUpsertMessageArgs,
    OutgoingMessagesGetForWorkerArgs, OutgoingMessagesWorkerMarkFailedArgs,
    OutgoingMessagesWorkerMarkSendingArgs, OutgoingMessagesWorkerMarkSentArgs,
};
use futures::{StreamExt, stream::BoxStream};
use messanger_interface::MessengerClient;
use tracing::{info, warn};

use crate::error::WorkerError;
use crate::job::{Job, JobCtx};
use crate::ops::convex::{ConvexResultExt as _, ConvexWarnExt as _};
use crate::session_manager::SessionManager as _;

const SERVICE: &str = "SendMessage";

pub struct SendMessagesJob;

#[async_trait]
impl Job for SendMessagesJob {
    fn name(&self) -> &'static str {
        SERVICE
    }

    async fn subscribe(&self, ctx: &JobCtx) -> anyhow::Result<BoxStream<'static, Vec<String>>> {
        let stream = ctx
            .convex
            .subscribe_outgoing_messages_pending_work()
            .await?;

        Ok(stream
            .filter_map(|res| async move {
                match res {
                    Ok(items) => Some(
                        items
                            .into_iter()
                            .filter(|item| item.service == SERVICE)
                            .map(|item| item.key)
                            .collect(),
                    ),
                    Err(error) => {
                        warn!(error = %error, "outgoingMessages.pendingWork subscription error");
                        None
                    }
                }
            })
            .boxed())
    }

    async fn run_one(&self, ctx: Arc<JobCtx>, outgoing_message_id: String) -> anyhow::Result<()> {
        let outgoing = ctx
            .convex
            .query_outgoing_messages_get_for_worker(OutgoingMessagesGetForWorkerArgs {
                outgoingMessageId: outgoing_message_id.clone(),
            })
            .await?
            .ok_or_else(|| anyhow::anyhow!("outgoing message {outgoing_message_id} not found"))?;

        let chat_external_id = match outgoing.chat_id.split_once(':') {
            Some((_, external_chat_id)) => external_chat_id.to_string(),
            None => outgoing.chat_id.clone(),
        };

        let client = ctx
            .convex
            .query_clients_get_for_worker(ClientsGetForWorkerArgs {
                clientId: outgoing.client_id.clone(),
            })
            .await?
            .ok_or_else(|| {
                WorkerError::MutationFailed(format!(
                    "outgoing message {outgoing_message_id}: client {} not found",
                    outgoing.client_id,
                ))
            })?;

        if client.user_id != outgoing.user_id {
            let error = format!(
                "Outgoing message owner mismatch: {} != {}",
                outgoing.user_id, client.user_id,
            );
            warn!(outgoing_message_id, %error);

            ctx.convex
                .outgoing_messages_worker_mark_failed(OutgoingMessagesWorkerMarkFailedArgs {
                    outgoingMessageId: outgoing.id,
                    error,
                })
                .await
                .check()?;

            return Ok(());
        }

        let tg = ctx
            .sessions
            .get_for_telegram_id(&outgoing.user_id, &client.telegram_id)
            .await
            .map_err(|error| WorkerError::ClientBuildFailed(error.to_string()))?;

        ctx.convex
            .outgoing_messages_worker_mark_sending(OutgoingMessagesWorkerMarkSendingArgs {
                outgoingMessageId: outgoing.id.clone(),
            })
            .await
            .check()?;

        let external_message_id = tg
            .send_message(&chat_external_id, &outgoing.text)
            .await
            .map_err(|error| WorkerError::MutationFailed(error.to_string()))?;

        let message_id = format!("{}:{}", outgoing.chat_id, external_message_id);
        let timestamp = current_timestamp_ms() as f64;

        let upsert_result = ctx
            .convex
            .messages_worker_upsert_message(MessagesWorkerUpsertMessageArgs {
                messageId: message_id,
                externalId: external_message_id.clone(),
                userId: outgoing.user_id.clone(),
                clientId: outgoing.client_id.clone(),
                chatId: outgoing.chat_id.clone(),
                senderId: client.telegram_id.clone(),
                text: Some(outgoing.text),
                outgoing: true,
                deleted: false,
                mediaExternalId: None,
                mediaKind: None,
                replyToMessageId: None,
                replyToText: None,
                forwardedFrom: None,
                reactions: None,
                ttlPeriod: None,
                ttlSeconds: None,
                timestamp,
            })
            .await
            .warn_on_err("failed to upsert sent outbound message");

        if upsert_result.is_none() {
            let error = "failed to upsert outbound message in messages table".to_string();
            warn!(
                outgoing_message_id,
                "Skipping markSent because upsert failed",
            );
            ctx.convex
                .outgoing_messages_worker_mark_failed(OutgoingMessagesWorkerMarkFailedArgs {
                    outgoingMessageId: outgoing.id,
                    error,
                })
                .await
                .check()?;
            return Ok(());
        }

        ctx.convex
            .outgoing_messages_worker_mark_sent(OutgoingMessagesWorkerMarkSentArgs {
                outgoingMessageId: outgoing.id,
                externalMessageId: external_message_id,
            })
            .await
            .check()?;

        info!(
            outgoing_message_id,
            chat_id = %outgoing.chat_id,
            user_id = %outgoing.user_id,
            "sent outgoing message",
        );

        Ok(())
    }
}

fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
