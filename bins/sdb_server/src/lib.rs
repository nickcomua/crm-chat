use std::str::FromStr;

use serde::{Deserialize, Serialize};
use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

// === Enums ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType, Serialize, Deserialize)]
pub enum ClientKind {
    Telegram,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType, Serialize, Deserialize)]
pub enum ChatType {
    Dialog,
    Group,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType, Serialize, Deserialize)]
pub enum MediaKind {
    Photo,
    Video,
    Audio,
    MessageRef,
}

// === Tables ===

#[spacetimedb::table(name = user, public)]
pub struct User {
    #[primary_key]
    pub id: Identity,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub online: bool,
}

#[spacetimedb::table(name = robot, public)]
pub struct Robot {
    #[primary_key]
    pub id: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub online: bool,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType, Serialize, Deserialize)]
pub enum ClientStatus {
    WaitingPhone(Option<String>),
    /// QR code login: None = waiting for QR URL to be generated, Some(url) = display this QR code
    WaitingQrCode(Option<String>),
    WaitingCode(Option<String>),
    WaitingPassword(Option<String>),
    Connected,
}

#[spacetimedb::table(name = client, public, index(name = user_client_pair, btree(columns = [owner_user_id, external_id])))]
#[derive(Debug)]
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
    pub session: String, // #todo remove or change it now it is just ignored
}

#[spacetimedb::table(name = chat, public)]
#[derive(Debug, Clone)]
pub struct Chat {
    #[primary_key]
    // #[auto_inc]
    pub id: String,
    #[index(btree)]
    pub owner_user_id: Identity,
    #[index(btree)]
    pub client_id: u64,
    #[index(btree)]
    pub chat_type: ChatType,
    // #[index(btree)]
    // pub external_chat_id: String,
    pub is_pinned: bool,
    pub pinned_name: Option<String>,
    #[index(btree)]
    pub last_message_ts: u64,
}

// #[spacetimedb::table(name = board, public)]
// pub struct Board {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     pub title: String,
//     #[index(btree)]
//     pub created_at: u64,
// }

// #[spacetimedb::table(name = board_user, public, index(name = board_user_pair, btree(columns = [board_id, user_id])))]
// pub struct BoardUser {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     #[index(btree)]
//     pub board_id: u64,
//     #[index(btree)]
//     pub user_id: Identity,
// }
// #[spacetimedb::table(name = note, public)]
// pub struct Note {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     #[index(btree)]
//     pub owner_user_id: Identity,
//     #[index(btree)]
//     pub board_id: u64,
//     pub text: Option<String>,
//     pub x: f64,
//     pub y: f64,
//     pub z: f64,
//     pub width: f64,
//     pub height: f64,
//     pub color: Option<String>,
// }

// #[spacetimedb::table(name = note_message, public, index(name = note_message_pair, btree(columns = [note_id, message_id])))]
// pub struct NoteMessage {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     #[index(btree)]
//     pub note_id: u64,
//     #[index(btree)]
//     pub message_id: u64,
// }

// #[spacetimedb::table(name = note_media, public, index(name = note_media_pair, btree(columns = [note_id, media_id])))]
// pub struct NoteMedia {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     #[index(btree)]
//     pub note_id: u64,
//     #[index(btree)]
//     pub media_id: u64,
// }

// #[spacetimedb::table(name = note_qa, public, index(name = note_qa_pair, btree(columns = [note_id, qa_id])))]
// pub struct NoteQa {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     #[index(btree)]
//     pub note_id: u64,
//     #[index(btree)]
//     pub qa_id: u64,
// }

// #[spacetimedb::table(name = media, public)]
// pub struct Media {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     #[index(btree)]
//     pub owner_user_id: Identity,
//     #[index(btree)]
//     pub client_id: u64,
//     #[index(btree)]
//     pub kind: MediaKind,
//     #[index(btree)]
//     pub url: String,
// }

#[spacetimedb::table(name = message, public, index(name = by_chat_ts, btree(columns = [chat_id, ts])))]
pub struct Message {
    #[primary_key]
    // #[auto_inc]
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

// #[spacetimedb::table(name = qa, public, index(name = qa_pair, btree(columns = [question_message_id, answer_message_id])))]
// pub struct Qa {
//     #[primary_key]
//     #[auto_inc]
//     pub id: u64,
//     #[index(btree)]
//     pub owner_user_id: Identity,
//     #[index(btree)]
//     pub question_message_id: u64,
//     #[index(btree)]
//     pub answer_message_id: u64,
//     #[index(btree)]
//     pub confidence: Option<f64>,
// }

#[derive(Debug, Serialize, Deserialize)]
struct BasicClaims {
    email: Option<String>,
    name: Option<String>,
}

#[reducer(client_connected)]
// Called when a client connects to a SpacetimeDB database
pub fn client_connected(ctx: &ReducerContext) -> Result<(), String> {
    let jwt = ctx
        .sender_auth()
        .jwt()
        .ok_or("Authentication required".to_string())?;
    log::info!("trying to loggin identity: {:?}", ctx.sender);
    // if jwt.issuer() != "https://noted-rabbit-14.clerk.accounts.dev" {
    if jwt.issuer() == "localhost" {
        if ctx.sender
            != Identity::from_str(
                #[allow(clippy::option_env_unwrap)]
                // DIRTY_IDENTITY env should be in a build time. option_env only for ci
                option_env!("DIRTY_IDENTITY")
                    .expect("DIRTY_IDENTITY env should be in a build time. option_env only for ci"),
            )
            .expect("Invalid identity env")
        {
            return Err("Invalid identity".to_string());
        }
        log::info!("robot connected! TODO add auth");
        if let Some(robot) = ctx.db.robot().id().find(ctx.sender) {
            ctx.db.robot().id().update(Robot {
                id: ctx.sender,
                online: true,
                updated_at: ctx.timestamp,
                ..robot
            });
        } else {
            ctx.db.robot().insert(Robot {
                id: ctx.sender,
                online: true,
                updated_at: ctx.timestamp,
                created_at: ctx.timestamp,
            });
        }
        return Ok(());
    }
    if ![
        "https://noted-rabbit-14.clerk.accounts.dev",
        "https://auth.spacetimedb.com",
    ]
    .contains(&jwt.issuer())
    {
        return Err("Invalid issuer".to_string());
    }

    let claims: BasicClaims = serde_json::from_slice(jwt.raw_payload().as_bytes())
        .map_err(|e| format!("Client connected with invalid JWT: {}", e).to_string())?;

    if let Some(user) = ctx.db.user().id().find(ctx.sender) {
        // If this is a returning user, i.e. we already have a `User` with this `Identity`,
        // set `online: true`, but leave `name` and `identity` unchanged.
        ctx.db.user().id().update(User {
            online: true,
            updated_at: ctx.timestamp,
            username: claims.email,
            display_name: claims.name,
            ..user
        });
    } else {
        // If this is a new user, create a `User` row for the `Identity`,
        // which is online, but hasn't set a name.
        ctx.db.user().insert(User {
            id: ctx.sender,
            username: claims.email,
            display_name: claims.name,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
            online: true,
        });
    }
    Ok(())
}

#[reducer(client_disconnected)]
// Called when a client disconnects from SpacetimeDB database
pub fn identity_disconnected(ctx: &ReducerContext) {
    if let Some(user) = ctx.db.user().id().find(ctx.sender) {
        ctx.db.user().id().update(User {
            online: false,
            updated_at: ctx.timestamp,
            ..user
        });
    } else if let Some(robot) = ctx.db.robot().id().find(ctx.sender) {
        ctx.db.robot().id().update(Robot {
            id: ctx.sender,
            online: false,
            updated_at: ctx.timestamp,
            ..robot
        });
    } else {
        // This branch should be unreachable,
        // as it doesn't make sense for a client to disconnect without connecting first.
        log::warn!(
            "Disconnect event for unknown user with identity {:?}",
            ctx.sender
        );
    }
}

fn validate_phone(phone: String) -> Result<(), String> {
    if !phonelib::is_valid_phone_number(phone.clone()) {
        return Err("invalid phone number".to_string());
    }
    if let Some(normalize_phone) = phonelib::normalize_phone_number(phone.clone()) {
        if normalize_phone != phone {
            return Err("phone number format is invalid".to_string());
        }
    } else {
        return Err("error normalizing phone".to_string());
    };
    Ok(())
}

#[reducer]
pub fn upsert_client(ctx: &ReducerContext, client: Client) -> Result<(), String> {
    log::info!(
        "upsert_client called: id={}, external_id={}, status={:?}, owner={:?}",
        client.id,
        client.external_id,
        client.status,
        client.owner_user_id
    );

    // For QR code login, external_id can be a temporary identifier (e.g., "qr:timestamp")
    // that gets updated to the actual phone after successful login
    let is_qr_login = matches!(client.status, ClientStatus::WaitingQrCode(_))
        || client.external_id.starts_with("qr:");

    if !is_qr_login {
        validate_phone(client.external_id.clone())?;
    }

    if let ClientStatus::WaitingPhone(Some(phone)) = &client.status {
        validate_phone(phone.clone())?;
    }
    if let ClientStatus::WaitingCode(Some(code)) = &client.status {
        // should be 5 numbers
        if !(code.len() == 5 && code.chars().all(|c| c.is_ascii_digit())) {
            return Err("auth code is invalid".to_string());
        }
    }

    // First, try to find by ID if provided (handles QR login where external_id changes)
    // This is important because during QR login, external_id changes from "qr:timestamp" to actual phone
    if client.id > 0 {
        if let Some(existing) = ctx.db.client().id().find(client.id) {
            log::info!(
                "Found existing client by id={}, updating external_id from {} to {}, status={:?}",
                existing.id,
                existing.external_id,
                client.external_id,
                client.status
            );
            ctx.db.client().id().update(client);
            return Ok(());
        }
    }

    // Fall back to lookup by (owner_user_id, external_id) pair
    if let Some(existing) = ctx
        .db
        .client()
        .user_client_pair()
        .filter((&client.owner_user_id.clone(), &client.external_id.clone()))
        .next()
    {
        log::info!(
            "Found existing client by external_id with id={}, updating to status={:?}",
            existing.id,
            client.status
        );
        ctx.db.client().id().update(Client {
            id: existing.id,
            ..client
        });
    } else {
        log::info!(
            "No existing client found, inserting new with external_id={}",
            client.external_id
        );
        ctx.db.client().insert(client);
    }
    Ok(())
}

#[reducer]
pub fn delete_client(ctx: &ReducerContext, client_id: u64) -> Result<(), String> {
    ctx.db.client().id().delete(client_id);
    Ok(())
}

// #[reducer]
// pub fn add_chats(ctx: &ReducerContext, chats: Vec<Chat>) -> Result<(), String> {
//     for chat in chats {
//         ctx.db.chat().insert(chat);
//     }
//     Ok(())
// }

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

#[reducer] // @todo when channel will be implemented
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

// pub fn add_messages(ctx: &ReducerContext, messages: Vec<Message>) -> Result<(), String> {
//     for message in messages {
//         ctx.db.message().insert(message);
//     }
//     Ok(())
// }

// === Row-Level Security (Client Visibility Filters) ===
// @todo
// Users can see themselves
// #[spacetimedb::client_visibility_filter]
// pub const USER_FILTER: Filter = Filter::Sql(
//     "
//     SELECT u.*
//     FROM user u
//     WHERE u.id = :sender",
// );

// // Users can see other users in shared boards
// #[spacetimedb::client_visibility_filter]
// pub const USER_FILTER_SHARED: Filter = Filter::Sql(
//     "
//     SELECT u.*
//     FROM user u
//     JOIN board_user bu
//     ON bu.user_id = u.id
//     JOIN board_user bu2
//     ON bu2.board_id = bu.board_id
//     WHERE bu2.user_id = :sender",
// );

// // Only owners can see their clients
// #[spacetimedb::client_visibility_filter]
// pub const CLIENT_FILTER: Filter = Filter::Sql(
//     "
//     SELECT c.*
//     FROM client c
//     WHERE c.owner_user_id = :sender",
// );

// // Only owners can see their chats
// #[spacetimedb::client_visibility_filter]
// pub const CHAT_FILTER: Filter = Filter::Sql(
//     "
//     SELECT ch.*
//     FROM chat ch
//     WHERE ch.owner_user_id = :sender",
// );

// // A board is visible to its members (semijoin)
// #[spacetimedb::client_visibility_filter]
// pub const BOARD_FILTER: Filter = Filter::Sql(
//     "SELECT b.*
//     FROM board b
//     JOIN board_user bu
//     ON bu.board_id = b.id
//     WHERE bu.user_id = :sender",
// );

// // Board membership rows: visible to the member
// #[spacetimedb::client_visibility_filter]
// pub const BOARD_USER_FILTER_SELF: Filter = Filter::Sql(
//     "
//     SELECT bu.*
//     FROM board_user bu
//     WHERE bu.user_id = :sender",
// );

// // Board membership rows: also visible to co-members of the same board
// #[spacetimedb::client_visibility_filter]
// pub const BOARD_USER_FILTER_COMEMBERS: Filter = Filter::Sql(
//     "SELECT bu.*
//     FROM board_user bu
//     JOIN board_user bu2
//     ON bu2.board_id = bu.board_id
//     WHERE bu2.user_id = :sender",
// );

// // Notes: owner
// #[spacetimedb::client_visibility_filter]
// pub const NOTE_FILTER_OWNER: Filter = Filter::Sql(
//     "
//     SELECT n.* FROM note n
//     WHERE n.owner_user_id = :sender",
// );

// // Notes: shared via board membership (semijoin)
// #[spacetimedb::client_visibility_filter]
// pub const NOTE_FILTER_SHARED: Filter = Filter::Sql(
//     "
//     SELECT n.*
//     FROM note n
//     JOIN board_note bn
//     ON bn.note_id = n.id
//     JOIN board_user bu
//     ON bu.board_id = bn.board_id
//     WHERE bu.user_id = :sender",
// );

// // Messages: owner
// #[spacetimedb::client_visibility_filter]
// pub const MESSAGE_FILTER_OWNER: Filter = Filter::Sql(
//     "
//     SELECT m.*
//     FROM message m
//     WHERE m.owner_user_id = :sender",
// );

// // Messages: shared via a note linked to a board where sender is a member (semijoin)
// #[spacetimedb::client_visibility_filter]
// pub const MESSAGE_FILTER_SHARED: Filter = Filter::Sql(
//     "
//     SELECT m.*
//     FROM message m
//     JOIN board_message bm
//     ON bm.message_id = m.id
//     JOIN board_user bu
//     ON bu.board_id = bm.board_id
//     WHERE bu.user_id = :sender",
// );

// // Media: owner
// #[spacetimedb::client_visibility_filter]
// pub const MEDIA_FILTER_OWNER: Filter = Filter::Sql(
//     "
//     SELECT me.*
//     FROM media me
//     WHERE me.owner_user_id = :sender",
// );

// // Media: shared via a note linked to a board where sender is a member (semijoin)
// #[spacetimedb::client_visibility_filter]
// pub const MEDIA_FILTER_SHARED: Filter = Filter::Sql(
//     "
//     SELECT me.*
//     FROM media me
//     JOIN board_media bme
//     ON bme.media_id = me.id
//     JOIN board_user bu
//     ON bu.board_id = bme.board_id
//     WHERE bu.user_id = :sender",
// );

// // QA: owner
// #[spacetimedb::client_visibility_filter]
// pub const QA_FILTER_OWNER: Filter = Filter::Sql(
//     "
//     SELECT q.*
//     FROM qa q
//     WHERE q.owner_user_id = :sender",
// );

// // QA: shared via a note linked to a board where sender is a member (semijoin)
// #[spacetimedb::client_visibility_filter]
// pub const QA_FILTER_SHARED: Filter = Filter::Sql(
//     "
//     SELECT q.*
//     FROM qa q
//     JOIN board_qa bq
//     ON bq.qa_id = q.id
//     JOIN board_user bu
//     ON bu.board_id = bq.board_id
//     WHERE bu.user_id = :sender",
// );
