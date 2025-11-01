use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use surrealdb::RecordId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DBMessageContent {
    Telegram(tl::enums::Message),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbMessage {
    pub id: RecordId,
    pub chat_id: RecordId,
    pub client_id: String,
    // pub content: Vec<DBMessageContent>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub out: bool,
    #[serde(default)]
    pub deleted: bool,
    pub is_question: Option<bool>,
    pub confidence: Option<f64>,
    pub answers: Option<Vec<RecordId>>,
    pub is_answer: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TgChat {
    User(tl::enums::User),
    Group(tl::enums::Chat),
    Channel(tl::types::Channel),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DbChatContent {
    Telegram(TgChat),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbChat {
    pub id: RecordId,
    pub client_id: String,
    pub content: Vec<DbChatContent>,
    pub is_pinned: Option<bool>,
    pub pined_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: RecordId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relation {
    pub r#in: RecordId,
    pub out: RecordId,
}
