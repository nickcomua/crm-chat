use serde::{Deserialize, Serialize};
use specta::Type;
use surrealdb::RecordId;

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct WordDefinition {
    pub id: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct Chat {
    pub id: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub is_pinned: Option<bool>,
    pub pined_name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct BoardNote {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub width: f64,
    pub height: f64,
    pub color: String,
    pub question_id: Option<String>,
    pub chat_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BoardNoteDb {
    pub id: RecordId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct BoardNoteCreate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct BoardNotePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub enum LiveQueryAction {
    #[serde(rename = "CREATE")]
    Create,
    #[serde(rename = "UPDATE")]
    Update,
    #[serde(rename = "DELETE")]
    Delete,
    #[serde(rename = "CLOSE")]
    Close,
    #[serde(rename = "BATCH_CREATE")]
    BatchCreate, // For sending initial data in batch
}

#[derive(Serialize, Deserialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct LiveQueryEvent {
    // pub subscription_id: String,
    pub query_key: String,
    pub action: LiveQueryAction,
    pub data: String, // JSON string representation of the data
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct LiveQueryRange {
    pub start: String,
    pub end: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub enum LiveQueryTable {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "board_note")]
    BoardNote,
    #[serde(rename = "message")]
    Message,
}