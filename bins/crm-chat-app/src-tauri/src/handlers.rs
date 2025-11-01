use crate::models::{BoardNote, BoardNoteCreate, BoardNotePatch, Chat, LiveQueryRange, LiveQueryTable, WordDefinition};
use crate::services::{BoardNoteService, ChatService, VectorService};
use tauri::command;

#[command]
#[specta::specta]
pub async fn get_chats() -> Result<Vec<Chat>, String> {
    ChatService::get_all().await.map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn get_messages(_chat_id: String) -> Result<Vec<Chat>, String> {
    // TODO: Implement proper message fetching; placeholder for now
    // This should fetch messages for the chat_id
    ChatService::get_all().await.map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn update_chat_pin(
    chat_id: String,
    is_pinned: bool,
    pined_name: Option<String>,
) -> Result<(), String> {
    ChatService::update_pin(chat_id, is_pinned, pined_name)
        .await
        .map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn update_chat_name(chat_id: String, pined_name: String) -> Result<(), String> {
    ChatService::update_name(chat_id, pined_name)
        .await
        .map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn merge_board_note(id: String, patch: BoardNotePatch) -> Result<(), String> {
    BoardNoteService::update(id, patch)
        .await
        .map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn create_board_note(board_note: BoardNoteCreate) -> Result<String, String> {
    let id = BoardNoteService::create(board_note)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id.to_string())
}

#[command]
#[specta::specta]
pub async fn delete_board_note(id: String) -> Result<(), String> {
    BoardNoteService::delete(id)
        .await
        .map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn get_board_notes(chat_id: String) -> Result<Vec<BoardNote>, String> {
    BoardNoteService::get_by_chat_id(chat_id)
        .await
        .map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn get_top_n(
    query: String,
    samples: u32,
) -> Result<Vec<(f64, String, WordDefinition)>, String> {
    VectorService::search_top_n(query, samples)
        .await
        .map_err(|e| e.to_string())
}

#[command]
#[specta::specta]
pub async fn subscribe_live_query(
    query_key: String,
    table: LiveQueryTable,
    range: Option<LiveQueryRange>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use crate::live_query::get_manager;

    let manager = get_manager().await;

    manager
        .subscribe(query_key, table, range, app)
        .await
        .map_err(|e| e.to_string())
}

// #[command]
// #[specta::specta]
// pub async fn unsubscribe_live_query(
//     subscription_id: String,
//     query_key: String,
// ) -> Result<(), String> {
//     use crate::live_query::get_manager;

//     let manager = get_manager().await;
//     manager
//         .unsubscribe(subscription_id, query_key)
//         .await
//         .map_err(|e| e.to_string())
// }
