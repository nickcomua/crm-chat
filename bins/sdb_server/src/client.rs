//! Client table and reducers for messenger connections.

use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::{TaskId, robot::robot};

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

// === Client Reducers ===

#[reducer]
pub fn upsert_client(ctx: &ReducerContext, client: Client) -> Result<(), String> {
    let is_robot = ctx.db.robot().id().find(ctx.sender).is_some();
    if !is_robot {
        return Err("unauthorized: only robots can modify clients".to_string());
    }

    if let Some(existing) = ctx
        .db
        .client()
        .user_client_pair()
        .filter((&client.owner_user_id.clone(), &client.external_id.clone()))
        .next()
    {
        ctx.db.client().id().update(Client {
            id: existing.id,
            ..client
        });
    } else {
        ctx.db.client().insert(client);
    }
    Ok(())
}

#[reducer]
pub fn delete_client(ctx: &ReducerContext, client_id: u64) -> Result<(), String> {
    ctx.db.client().id().delete(client_id);
    Ok(())
}
