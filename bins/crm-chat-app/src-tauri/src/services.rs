use crate::models::{Chat, BoardNote, BoardNoteCreate, BoardNotePatch, WordDefinition};
use crate::repositories::{ChatRepo, BoardNoteRepo, VectorRepo};
use anyhow::Result;
use surrealdb::RecordId;

pub struct ChatService;

impl ChatService {
    pub async fn get_all() -> Result<Vec<Chat>> {
        ChatRepo::get_all().await
    }

    pub async fn update_pin(chat_id: String, is_pinned: bool, pined_name: Option<String>) -> Result<()> {
        // Basic validation
        if chat_id.is_empty() {
            return Err(anyhow::anyhow!("Chat ID cannot be empty"));
        }
        ChatRepo::update_pin(chat_id, is_pinned, pined_name).await
    }

    pub async fn update_name(chat_id: String, name: String) -> Result<()> {
        // Basic validation
        if chat_id.is_empty() {
            return Err(anyhow::anyhow!("Chat ID cannot be empty"));
        }
        if name.is_empty() {
            return Err(anyhow::anyhow!("Name cannot be empty"));
        }
        ChatRepo::update_name(chat_id, name).await
    }
}

pub struct BoardNoteService;

impl BoardNoteService {
    pub async fn get_by_chat_id(chat_id: String) -> Result<Vec<BoardNote>> {
        if chat_id.is_empty() {
            return Err(anyhow::anyhow!("Chat ID cannot be empty"));
        }
        BoardNoteRepo::get_by_chat_id(chat_id).await
    }

    pub async fn create(create: BoardNoteCreate) -> Result<RecordId> {
        // Basic validation
        if create.chat_id.is_none() || create.chat_id.as_ref().unwrap().is_empty() {
            return Err(anyhow::anyhow!("Chat ID is required for board note"));
        }
        BoardNoteRepo::create(create).await
    }

    pub async fn update(id: String, patch: BoardNotePatch) -> Result<()> {
        if id.is_empty() {
            return Err(anyhow::anyhow!("Board note ID cannot be empty"));
        }
        BoardNoteRepo::update(id, patch).await
    }

    pub async fn delete(id: String) -> Result<()> {
        if id.is_empty() {
            return Err(anyhow::anyhow!("Board note ID cannot be empty"));
        }
        BoardNoteRepo::delete(id).await
    }
}

pub struct VectorService;

impl VectorService {
    pub async fn search_top_n(query: String, limit: u32) -> Result<Vec<(f64, String, WordDefinition)>> {
        if query.is_empty() {
            return Err(anyhow::anyhow!("Query cannot be empty"));
        }
        if limit == 0 {
            return Err(anyhow::anyhow!("Limit must be greater than 0"));
        }
        VectorRepo::search_top_n(query, limit).await
    }
}