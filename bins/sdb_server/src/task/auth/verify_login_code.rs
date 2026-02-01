//! VerifyLoginCode task - Robot task that verifies the code with Telegram.

use spacetimedb::{ReducerContext, Table};

use crate::task::task;
use crate::{validation, ClientStatus};

use super::super::{
    delete_client, new_task_id, send_error, Task, TaskPayload, TaskStatus, Taskable, TaskType,
    update_client_status,
};
use super::super::shared::{LoginToken, PasswordToken, SignInSuccess};
use super::receive_login_code::{ReceiveLoginCode, ReceiveLoginCodeOutput};
use super::receive_password::{ReceivePassword, ReceivePasswordOutput};

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyLoginCodeOutput {
    Pending,
    Success(SignInSuccess),
    PasswordRequired(PasswordToken),
    InvalidCode,
    SignUpRequired,
    Failed(String),
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyLoginCode {
    pub client_phone: String,
    pub token: LoginToken,
    pub code: String,
    pub output: VerifyLoginCodeOutput,
}

impl Taskable for VerifyLoginCode {
    fn validate(&self) -> Result<(), String> {
        validation::phone(&self.client_phone)?;
        validation::auth_code(&self.code)
    }

    fn is_done(&self) -> bool {
        !matches!(self.output, VerifyLoginCodeOutput::Pending)
    }

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        let payload = match &task.payload {
            TaskPayload::VerifyLoginCode(p) => p,
            _ => return Err("invalid task payload".to_string()),
        };

        match &payload.output {
            VerifyLoginCodeOutput::Success(_sign_in) => {
                // Successfully logged in
                update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::Connected,
                )?;
            }
            VerifyLoginCodeOutput::PasswordRequired(token) => {
                // 2FA required, create ReceivePassword task
                let new_task_id = new_task_id(ctx);
                ctx.db.task().insert(Task {
                    id: new_task_id.clone(),
                    owner_user_id: task.owner_user_id,
                    payload: TaskPayload::ReceivePassword(ReceivePassword {
                        client_phone: payload.client_phone.clone(),
                        hint: token.hint.clone(),
                        token: token.token.clone(),
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
            }
            VerifyLoginCodeOutput::InvalidCode => {
                // Invalid code, let user retry - create new ReceiveLoginCode task
                let new_task_id = new_task_id(ctx);
                ctx.db.task().insert(Task {
                    id: new_task_id.clone(),
                    owner_user_id: task.owner_user_id,
                    payload: TaskPayload::ReceiveLoginCode(ReceiveLoginCode {
                        client_phone: payload.client_phone.clone(),
                        token: payload.token.clone(),
                        output: ReceiveLoginCodeOutput::Pending,
                    }),
                    status: TaskStatus::Unassigned,
                    created_at: ctx.timestamp,
                    updated_at: ctx.timestamp,
                });

                update_client_status(
                    ctx,
                    &task.owner_user_id,
                    &payload.client_phone,
                    ClientStatus::ReceivingLoginCode(new_task_id),
                )?;

                send_error(
                    ctx,
                    task.owner_user_id,
                    "Invalid code. Please try again.".to_string(),
                );
            }
            VerifyLoginCodeOutput::SignUpRequired => {
                // Sign up required - not supported, delete client
                delete_client(ctx, &task.owner_user_id, &payload.client_phone);
                send_error(
                    ctx,
                    task.owner_user_id,
                    "Sign up required. This phone number is not registered with Telegram."
                        .to_string(),
                );
            }
            VerifyLoginCodeOutput::Failed(error) => {
                // Failed, delete client and notify
                delete_client(ctx, &task.owner_user_id, &payload.client_phone);
                send_error(
                    ctx,
                    task.owner_user_id,
                    format!("Failed to verify login code: {}", error),
                );
            }
            VerifyLoginCodeOutput::Pending => {
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
