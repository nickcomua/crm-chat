//! Chat table and reducers.

use serde::{Deserialize, Serialize};
use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::robot::robot;

// === Chat Type ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType, Serialize, Deserialize)]
pub enum ChatType {
    Dialog,
    Group,
}

// === Chat Table ===

#[spacetimedb::table(name = chat, public)]
#[derive(Debug, Clone)]
pub struct Chat {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner_user_id: Identity,
    #[index(btree)]
    pub client_id: u64,
    #[index(btree)]
    pub chat_type: ChatType,
    pub is_pinned: bool,
    pub pinned_name: Option<String>,
    #[index(btree)]
    pub last_message_ts: u64,
}

// === Chat Reducers ===

#[reducer]
pub fn upsert_chat(ctx: &ReducerContext, chat: Chat) -> Result<(), String> {
    // Authorization guard: only the owner can modify their chats
    let is_robot = ctx.db.robot().id().find(ctx.sender).is_some();
    if !is_robot && chat.owner_user_id != ctx.sender {
        return Err("unauthorized: cannot modify another user's chat".to_string());
    }

    if let Some(_existing) = ctx.db.chat().id().find(chat.id.clone()) {
        ctx.db.chat().id().update(chat);
    } else {
        ctx.db.chat().insert(chat);
    }
    Ok(())
}

#[reducer]
pub fn delete_chat(ctx: &ReducerContext, chat_id: String) -> Result<(), String> {
    ctx.db.chat().id().delete(chat_id);
    Ok(())
}
