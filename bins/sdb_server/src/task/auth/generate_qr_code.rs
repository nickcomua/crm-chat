//! GenerateQrCode task - Robot task for QR code authentication.

use spacetimedb::{ReducerContext, Table};

use crate::client::client;
use crate::task::task;
use crate::{Client, ClientKind, ClientStatus};

use super::super::{send_error, Task, TaskPayload, Taskable, TaskType};
use super::super::shared::{QrToken, SignInSuccess};

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum GenerateQrCodeOutput {
    Pending,
    Token(QrToken),
    Authorized(SignInSuccess),
    AlreadyAuthorized(SignInSuccess),
    Cancelled,
    Failed(String),
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct GenerateQrCode {
    pub output: GenerateQrCodeOutput,
}

impl Taskable for GenerateQrCode {
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }

    fn is_done(&self) -> bool {
        matches!(
            self.output,
            GenerateQrCodeOutput::Authorized(_)
                | GenerateQrCodeOutput::AlreadyAuthorized(_)
                | GenerateQrCodeOutput::Cancelled
                | GenerateQrCodeOutput::Failed(_)
        )
    }

    // No on_create - client is only created on successful authorization

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        let payload = match &task.payload {
            TaskPayload::GenerateQrCode(p) => p,
            _ => return Err("invalid task payload".to_string()),
        };

        match &payload.output {
            GenerateQrCodeOutput::Authorized(sign_in)
            | GenerateQrCodeOutput::AlreadyAuthorized(sign_in) => {
                // Create or update client on successful QR authorization
                let external_id = sign_in.user_id.to_string();

                // Find existing client first, then decide what to do
                let existing = ctx
                    .db
                    .client()
                    .user_client_pair()
                    .filter((&task.owner_user_id, &external_id))
                    .next();

                if let Some(existing) = existing {
                    // Update existing client to Connected status
                    ctx.db.client().id().update(Client {
                        status: ClientStatus::Connected,
                        ..existing
                    });
                } else {
                    // Create new client
                    ctx.db.client().insert(Client {
                        id: 0,
                        active_chats: vec![],
                        external_id,
                        owner_user_id: task.owner_user_id,
                        kind: ClientKind::Telegram,
                        status: ClientStatus::Connected,
                    });
                }
            }
            GenerateQrCodeOutput::Cancelled => {
                // User cancelled - nothing to do, just clean up the task
            }
            GenerateQrCodeOutput::Failed(error) => {
                send_error(
                    ctx,
                    task.owner_user_id,
                    format!("QR code login failed: {}", error),
                );
            }
            GenerateQrCodeOutput::Token(_) | GenerateQrCodeOutput::Pending => {
                // Token is an intermediate state, task is not truly done
                return Err("Task is not done".to_string());
            }
        }

        ctx.db.task().id().delete(task.id.clone());
        Ok(())
    }

    fn task_type(&self) -> TaskType {
        TaskType::Robot
    }
}
