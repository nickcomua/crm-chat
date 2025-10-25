use crate::db::db;
use crate::models::{Chat, BoardNote, BoardNoteCreate, BoardNotePatch, WordDefinition};
use anyhow::{Context, Result};
use chat_types::Record;
use surrealdb::RecordId;
use std::str::FromStr;

pub struct ChatRepo;

impl ChatRepo {
    pub async fn get_all() -> Result<Vec<Chat>> {
        let db = db().await;
        let sql = r#"
            SELECT 
                type::string(id) as id, 
                is_pinned,
                pined_name,
                content[0].Telegram.User.User.username as username, 
                content[0].Telegram.User.User.first_name as first_name, 
                content[0].Telegram.User.User.last_name as last_name, 
                content[0].Telegram.User.User.phone as phone 
            FROM chat
        "#;
        let mut result = db.query(sql).await?;
        let chats: Vec<Chat> = result.take::<Vec<Chat>>(0)?;
        Ok(chats)
    }

    pub async fn update_pin(chat_id: String, is_pinned: bool, pined_name: Option<String>) -> Result<()> {
        let rid = RecordId::from_str(&chat_id).context("Invalid chat ID")?;
        let db = db().await;
        let mut patch = serde_json::Map::new();
        patch.insert("is_pinned".to_string(), serde_json::Value::Bool(is_pinned));
        if let Some(name) = pined_name {
            patch.insert("pined_name".to_string(), serde_json::Value::String(name));
        } else {
            patch.insert("pined_name".to_string(), serde_json::Value::Null);
        }
        db.query("UPDATE $rid MERGE $patch RETURN NONE")
            .bind(("rid", rid))
            .bind(("patch", serde_json::Value::Object(patch)))
            .await?;
        Ok(())
    }

    pub async fn update_name(chat_id: String, name: String) -> Result<()> {
        let rid = RecordId::from_str(&chat_id).context("Invalid chat ID")?;
        let db = db().await;
        let patch = serde_json::json!({ "pined_name": name });
        db.query("UPDATE $rid MERGE $patch RETURN NONE")
            .bind(("rid", rid))
            .bind(("patch", patch))
            .await?;
        Ok(())
    }
}

pub struct BoardNoteRepo;

impl BoardNoteRepo {
    pub async fn get_by_chat_id(chat_id: String) -> Result<Vec<BoardNote>> {
        let db = db().await;
        let sql = r#"
            SELECT * FROM boardnote WHERE chat_id = $chat_id
        "#;
        let mut result = db.query(sql)
            .bind(("chat_id", chat_id))
            .await?;
        let notes: Vec<BoardNote> = result.take::<Vec<BoardNote>>(0)?;
        Ok(notes)
    }

    pub async fn create(create: BoardNoteCreate) -> Result<RecordId> {
        let db = db().await;
        let content = serde_json::to_value(create)?;
        let mut result = db.query("CREATE boardnote CONTENT $content RETURN id")
            .bind(("content", content))
            .await?;
        let ids: Vec<Record> = result.take(0)?;
        let id = ids.first().context("No id returned")?.clone();
        Ok(id.id)
    }

    pub async fn update(id: String, patch: BoardNotePatch) -> Result<()> {
        let rid = RecordId::from_str(&id).context("Invalid board note ID")?;
        let db = db().await;
        let patch_val = serde_json::to_value(patch)?;
        db.query("UPDATE $rid MERGE $patch RETURN NONE")
            .bind(("rid", rid))
            .bind(("patch", patch_val))
            .await?;
        Ok(())
    }

    pub async fn delete(id: String) -> Result<()> {
        let rid = RecordId::from_str(&id).context("Invalid board note ID")?;
        let db = db().await;
        db.query("DELETE $rid")
            .bind(("rid", rid))
            .await?;
        Ok(())
    }
}

pub struct VectorRepo;

impl VectorRepo {
    // Assuming vector_store is accessible; this abstracts the search
    pub async fn search_top_n(query: String, limit: u32) -> Result<Vec<(f64, String, WordDefinition)>> {
        use crate::vector::vector_store;
        use rig::vector_store::{VectorSearchRequest, VectorStoreError, VectorStoreIndex};

        let req = VectorSearchRequest::builder()
            .query(&query)
            .samples(limit as u64)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build search request: {}", e))?;

        let results = vector_store()
            .await
            .top_n::<WordDefinition>(req)
            .await
            .map_err(|e: VectorStoreError| anyhow::anyhow!("Vector search failed: {}", e))?;
        Ok(results)
    }
}