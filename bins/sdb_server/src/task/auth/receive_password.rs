//! ReceivePassword task - Human task for user to enter their 2FA password.

use spacetimedb::{ReducerContext, Table};

use crate::task::task;
use crate::{validation, ClientStatus};

use super::super::{
    delete_client, new_task_id, send_error, Task, TaskPayload, TaskStatus, Taskable, TaskType,
    update_client_status,
};
use super::verify_password::{VerifyPassword, VerifyPasswordOutput};

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum ReceivePasswordOutput {
    Pending,
    Success(String), // The password entered by user
    Aborted,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct ReceivePassword {
    pub client_phone: String,
    pub hint: Option<String>,
    pub token: String,
    pub output: ReceivePasswordOutput,
}

impl Taskable for ReceivePassword {
    fn validate(&self) -> Result<(), String> {
        validation::phone(&self.client_phone)
    }

    fn is_done(&self) -> bool {
        !matches!(self.output, ReceivePasswordOutput::Pending)
    }

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        let payload = match &task.payload {
            TaskPayload::ReceivePassword(p) => p,
            _ => return Err("invalid task payload".to_string()),
        };

        match &payload.output {
            ReceivePasswordOutput::Success(password) => {
                // User entered password, create VerifyPassword task
                let new_task_id = new_task_id(ctx);
                ctx.db.task().insert(Task {
                    id: new_task_id.clone(),
                    owner_user_id: task.owner_user_id,
                    payload: TaskPayload::VerifyPassword(VerifyPassword {
                        client_phone: payload.client_phone.clone(),
                        password: password.clone(),
                        token: payload.token.clone(),
                        output: VerifyPasswordOutput::Pending,
                    }),
                    status: TaskStatus::Unassigned,
                    created_at: ctx.timestamp,
                    updated_at: ctx.timestamp,
                });

                update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::VerifyingPassword(new_task_id),
                )?;
            }
            ReceivePasswordOutput::Aborted => {
                // User aborted, delete client and notify
                delete_client(ctx, &task.owner_user_id, &payload.client_phone);
                send_error(ctx, task.owner_user_id, "Login aborted by user".to_string());
            }
            ReceivePasswordOutput::Pending => {
                return Err("Task is not done".to_string());
            }
        }

        ctx.db.task().id().delete(task.id.clone());
        Ok(())
    }

    fn task_type(&self) -> TaskType {
        TaskType::Human
    }
}
