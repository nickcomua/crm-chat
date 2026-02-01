//! Client table and reducers for messenger connections.

use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::{TaskId, cancel_task, robot::robot, task::task};

// === Client Kind ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum ClientKind {
    Telegram,
}

// === Client Status ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum ClientStatus {
    SendingLoginCode(TaskId),
    ReceivingLoginCode(TaskId),
    VerifyingLoginCode(TaskId),
    ReceivingPassword(TaskId),
    VerifyingPassword(TaskId),
    GeneratingQrCode(TaskId),
    Connected,
    Error(String),
}

// === Client Table ===

#[spacetimedb::table(name = client, public, index(name = user_client_pair, btree(columns = [owner_user_id, external_id])))]
#[derive(Debug, Clone)]
pub struct Client {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub owner_user_id: Identity,
    #[index(btree)]
    pub kind: ClientKind,
    pub external_id: String,
    pub active_chats: Vec<u64>,
    pub status: ClientStatus,
}

#[reducer]
pub fn delete_client(ctx: &ReducerContext, client_id: u64) -> Result<(), String> {
    let client = ctx.db.client().id().find(client_id);
    if client.is_none() {
        return Err("client not found".to_string());
    }
    let client = client.unwrap();

    if client.owner_user_id != ctx.sender {
        return Err("client not owned by this user".to_string());
    }

    let task_id = match client.status {
        ClientStatus::SendingLoginCode(task_id) => Some(task_id),
        ClientStatus::ReceivingLoginCode(task_id) => Some(task_id),
        ClientStatus::VerifyingLoginCode(task_id) => Some(task_id),
        ClientStatus::ReceivingPassword(task_id) => Some(task_id),
        ClientStatus::VerifyingPassword(task_id) => Some(task_id),
        ClientStatus::GeneratingQrCode(task_id) => Some(task_id),
        ClientStatus::Connected => None,
        ClientStatus::Error(_) => None,
    };
    if let Some(task_id) = task_id {
        ctx.db.task().id().delete(task_id);
    }

    ctx.db.client().id().delete(client_id);
    Ok(())
}
