//! Client table and reducers for messenger connections.

use spacetimedb::{reducer, Identity, ReducerContext};

use crate::phone_auth::phone_auth;
use crate::PhoneAuthStep;

// === Client Kind ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum ClientKind {
    Telegram,
}

// === Client Status ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum ClientStatus {
    Authenticating,
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
    let client = ctx
        .db
        .client()
        .id()
        .find(client_id)
        .ok_or("client not found")?;

    if client.owner_user_id != ctx.sender {
        return Err("client not owned by this user".to_string());
    }

    // Cancel any active phone auth sessions for this client
    let phone_auths: Vec<_> = ctx
        .db
        .phone_auth()
        .owner_user_id()
        .filter(&ctx.sender)
        .filter(|auth| auth.client_id == client_id && !auth.step.is_terminal())
        .collect();
    for auth in phone_auths {
        ctx.db.phone_auth().id().update(crate::PhoneAuth {
            step: PhoneAuthStep::Cancelled,
            updated_at: ctx.timestamp,
            ..auth
        });
    }

    // Cancel any active QR auth sessions owned by this user that aren't terminal
    // (QR auths don't have a client_id since client is created on success)
    // We don't cancel QR auths here since they're not tied to a specific client

    ctx.db.client().id().delete(client_id);
    Ok(())
}
