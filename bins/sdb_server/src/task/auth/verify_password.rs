//! VerifyPassword task - Robot task that verifies 2FA password with Telegram.

use spacetimedb::{ReducerContext, Table};

use crate::task::task;
use crate::{validation, ClientStatus};

use super::super::{
    delete_client, new_task_id, send_error, Task, TaskPayload, TaskStatus, Taskable, TaskType,
    update_client_status,
};
use super::super::shared::SignInSuccess;
use super::receive_password::{ReceivePassword, ReceivePasswordOutput};

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyPasswordOutput {
    Pending,
    Success(SignInSuccess),
    InvalidPassword,
    Failed(String),
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyPassword {
    pub client_phone: String,
    pub password: String,
    pub token: String,
    pub output: VerifyPasswordOutput,
}

impl Taskable for VerifyPassword {
    fn validate(&self) -> Result<(), String> {
        validation::phone(&self.client_phone)?;
        validation::password(&self.password)
    }

    fn is_done(&self) -> bool {
        !matches!(self.output, VerifyPasswordOutput::Pending)
    }

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        let payload = match &task.payload {
            TaskPayload::VerifyPassword(p) => p,
            _ => return Err("invalid task payload".to_string()),
        };

        match &payload.output {
            VerifyPasswordOutput::Success(_sign_in) => {
                // Successfully logged in
                update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::Connected,
                )?;
            }
            VerifyPasswordOutput::InvalidPassword => {
                // Invalid password, let user retry - create new ReceivePassword task
                // We need to get the hint from somewhere - for now we'll leave it empty
                let new_task_id = new_task_id(ctx);
                ctx.db.task().insert(Task {
                    id: new_task_id.clone(),
                    owner_user_id: task.owner_user_id,
                    payload: TaskPayload::ReceivePassword(ReceivePassword {
                        client_phone: payload.client_phone.clone(),
                        hint: None, // Hint is lost on retry, could store it on client if needed
                        token: payload.token.clone(),
                        output: ReceivePasswordOutput::Pending,
                    }),
                    status: TaskStatus::Unassigned,
                    created_at: ctx.timestamp,
                    updated_at: ctx.timestamp,
                });

                update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::ReceivingPassword(new_task_id),
                )?;

                send_error(
                    ctx,
                    task.owner_user_id,
                    "Invalid password. Please try again.".to_string(),
                );
            }
            VerifyPasswordOutput::Failed(error) => {
                // Failed, delete client and notify
                delete_client(ctx, &task.owner_user_id, &payload.client_phone);
                send_error(
                    ctx,
                    task.owner_user_id,
                    format!("Failed to verify password: {}", error),
                );
            }
            VerifyPasswordOutput::Pending => {
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
