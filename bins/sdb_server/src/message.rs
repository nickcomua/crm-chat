//! Message table and reducers.

use serde::{Deserialize, Serialize};
use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::robot::robot;

// === Media Kind ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType, Serialize, Deserialize)]
pub enum MediaKind {
    Photo,
    Video,
    Audio,
    MessageRef,
}

// === Message Table ===

#[spacetimedb::table(name = message, public, index(name = by_chat_ts, btree(columns = [chat_id, ts])))]
pub struct Message {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub external_id: String,
    #[index(btree)]
    pub owner_user_id: Identity,
    #[index(btree)]
    pub client_id: u64,
    #[index(btree)]
    pub chat_id: String,
    pub sender_id: String,
    pub text: Option<String>,
    pub out: bool,
    pub deleted: bool,
    #[index(btree)]
    pub ts: u64, // UTC ms since epoch
    #[index(btree)]
    pub media_id: Option<u64>,
}

// === Message Reducers ===

#[reducer]
pub fn upsert_message(ctx: &ReducerContext, message: Message) -> Result<(), String> {
    // Authorization guard: only the owner can modify their messages
    let is_robot = ctx.db.robot().id().find(ctx.sender).is_some();
    if !is_robot && message.owner_user_id != ctx.sender {
        return Err("unauthorized: cannot modify another user's message".to_string());
    }

    if let Some(_existing) = ctx.db.message().id().find(message.id.clone()) {
        ctx.db.message().id().update(message);
    } else {
        ctx.db.message().insert(message);
    }
    Ok(())
}

#[reducer]
pub fn mark_message_deleted(
    ctx: &ReducerContext,
    external_message_id: String,
) -> Result<(), String> {
    if let [existing] = ctx
        .db
        .message()
        .external_id()
        .filter(&external_message_id)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ctx.db.message().id().update(Message {
            id: existing.id.clone(),
            external_id: existing.external_id.clone(),
            owner_user_id: existing.owner_user_id,
            client_id: existing.client_id,
            chat_id: existing.chat_id.clone(),
            text: existing.text.clone(),
            sender_id: existing.sender_id.clone(),
            out: existing.out,
            deleted: true,
            ts: existing.ts,
            media_id: existing.media_id,
        });
    } else {
        return Err("message not found or its more than one".to_string());
    }
    Ok(())
}
