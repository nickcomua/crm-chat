//! ReceiveLoginCode task - Human task for user to enter the received code.

use spacetimedb::{ReducerContext, Table};

use crate::task::task;
use crate::{validation, ClientStatus};

use super::super::{
    delete_client, new_task_id, send_error, Task, TaskPayload, TaskStatus, Taskable, TaskType,
    update_client_status,
};
use super::super::shared::LoginToken;
use super::verify_login_code::{VerifyLoginCode, VerifyLoginCodeOutput};

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum ReceiveLoginCodeOutput {
    Pending,
    Success(String), // The code entered by user
    Aborted,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct ReceiveLoginCode {
    pub client_phone: String,
    pub token: LoginToken,
    pub output: ReceiveLoginCodeOutput,
}

impl Taskable for ReceiveLoginCode {
    fn validate(&self) -> Result<(), String> {
        validation::phone(&self.client_phone)
    }

    fn is_done(&self) -> bool {
        !matches!(self.output, ReceiveLoginCodeOutput::Pending)
    }

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        let payload = match &task.payload {
            TaskPayload::ReceiveLoginCode(p) => p,
            _ => return Err("invalid task payload".to_string()),
        };

        match &payload.output {
            ReceiveLoginCodeOutput::Success(code) => {
                // User entered a code, create VerifyLoginCode task
                let new_task_id = new_task_id(ctx);
                ctx.db.task().insert(Task {
                    id: new_task_id.clone(),
                    owner_user_id: task.owner_user_id,
                    payload: TaskPayload::VerifyLoginCode(VerifyLoginCode {
                        client_phone: payload.client_phone.clone(),
                        token: payload.token.clone(),
                        code: code.clone(),
                        output: VerifyLoginCodeOutput::Pending,
                    }),
                    status: TaskStatus::Unassigned,
                    created_at: ctx.timestamp,
                    updated_at: ctx.timestamp,
                });

                update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::VerifyingLoginCode(new_task_id),
                )?;
            }
            ReceiveLoginCodeOutput::Aborted => {
                // User aborted, delete client and notify
                delete_client(ctx, &task.owner_user_id, &payload.client_phone);
                send_error(ctx, task.owner_user_id, "Login aborted by user".to_string());
            }
            ReceiveLoginCodeOutput::Pending => {
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
