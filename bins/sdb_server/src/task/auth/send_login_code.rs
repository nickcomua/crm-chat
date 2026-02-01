//! SendLoginCode task - Robot task that sends SMS code to phone.

use spacetimedb::{ReducerContext, Table};

use crate::client::client;
use crate::task::task;
use crate::{validation, Client, ClientKind, ClientStatus};

use super::super::{
    delete_client, get_one_client, new_task_id, send_error, Task, TaskPayload, TaskStatus,
    Taskable, TaskType,
};
use super::super::shared::LoginToken;
use super::receive_login_code::{ReceiveLoginCode, ReceiveLoginCodeOutput};

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum SendLoginCodeOutput {
    Pending,
    Success(LoginToken),
    AlreadyAuthorized,
    Failed(String),
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct SendLoginCode {
    pub client_phone: String,
    pub output: SendLoginCodeOutput,
}

impl Taskable for SendLoginCode {
    fn validate(&self) -> Result<(), String> {
        validation::phone(&self.client_phone)
    }

    fn is_done(&self) -> bool {
        !matches!(self.output, SendLoginCodeOutput::Pending)
    }

    fn on_create(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        let payload = match &task.payload {
            TaskPayload::SendLoginCode(p) => p,
            _ => return Err("invalid task payload".to_string()),
        };

        // Check if client already exists
        if get_one_client(ctx, &task.owner_user_id, &payload.client_phone).is_some() {
            send_error(ctx, task.owner_user_id, "Client already exists".to_string());
            return Err("Client already exists".to_string());
        }

        // Create the client in SendingLoginCode state
        ctx.db.client().insert(Client {
            id: 0,
            active_chats: vec![],
            external_id: payload.client_phone.clone(),
            owner_user_id: task.owner_user_id,
            kind: ClientKind::Telegram,
            status: ClientStatus::SendingLoginCode(task.id.clone()),
        });

        Ok(())
    }

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        let payload = match &task.payload {
            TaskPayload::SendLoginCode(p) => p,
            _ => return Err("invalid task payload".to_string()),
        };

        match &payload.output {
            SendLoginCodeOutput::Success(token) => {
                // Create ReceiveLoginCode task for user to enter the code
                let new_task_id = new_task_id(ctx);
                ctx.db.task().insert(Task {
                    id: new_task_id.clone(),
                    owner_user_id: task.owner_user_id,
                    payload: TaskPayload::ReceiveLoginCode(ReceiveLoginCode {
                        client_phone: payload.client_phone.clone(),
                        token: token.clone(),
                        output: ReceiveLoginCodeOutput::Pending,
                    }),
                    status: TaskStatus::Unassigned,
                    created_at: ctx.timestamp,
                    updated_at: ctx.timestamp,
                });

                super::super::update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::ReceivingLoginCode(new_task_id),
                )?;
            }
            SendLoginCodeOutput::AlreadyAuthorized => {
                // Client is already authorized, mark as connected
                super::super::update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::Connected,
                )?;
            }
            SendLoginCodeOutput::Failed(error) => {
                // Delete the client and notify user
                delete_client(ctx, &task.owner_user_id, &payload.client_phone);
                send_error(
                    ctx,
                    task.owner_user_id,
                    format!("Failed to send login code: {}", error),
                );
            }
            SendLoginCodeOutput::Pending => {
                return Err("Task is not done".to_string());
            }
        }

        // Delete the completed task
        ctx.db.task().id().delete(task.id.clone());
        Ok(())
    }

    fn task_type(&self) -> TaskType {
        TaskType::Robot
    }
}
