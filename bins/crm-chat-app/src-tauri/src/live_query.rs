use crate::db::db;
use crate::models::{BoardNote, BoardNoteDb, LiveQueryAction, LiveQueryEvent, LiveQueryRange, LiveQueryTable};
use anyhow::Result;
use chat_types::{DbChat, DbMessage, Record, TgChat};
use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use surrealdb::{Action, Notification, Value};
// use futures::StreamExt; // Will be needed when WebSocket notification streaming is implemented
use std::sync::Arc;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::OnceCell;

// struct SubscriptionState {
//     abort_handle: tokio::task::AbortHandle,
//     query_key: String,
// }

pub struct LiveQueryManager {
    // subscriptions: Arc<RwLock<HashMap<Uuid, SubscriptionState>>>,
}

const BATCH_SIZE: u64 = 10_000;
impl LiveQueryManager {
    // pub fn new() -> Self {
    //     Self {
    //         subscriptions: Arc::new(RwLock::new(HashMap::new())),
    //     }
    // }

    async fn subscribe_table<T: Serialize + DeserializeOwned + Unpin>(
        &self,
        query_key: String,
        range: Option<LiveQueryRange>,
        table: String,
        app: AppHandle,
    ) -> Result<()> {
        let db = db().await;
        // let mut query: surrealdb::method::Select<'_, surrealdb::engine::any::Any, Vec<T>> = db.select::<Vec<T>>(&table);
        let mut live_query = db.select::<Vec<T>>(&table);
        if let Some(range) = &range {
            // query = query.range(range.start.clone()..=range.end.clone());
            live_query = live_query.range(&range.start..=&range.end);
        }
        println!("got db");
        let mut start = 0;
        loop {
            // @todo change to bind
            let data = db
                .query(format!(
                    "SELECT * FROM {table}{} START $start LIMIT $limit",
                    if let Some(range) = &range {
                        format!(":⟨{}⟩..=⟨{}⟩", &range.start, &range.end)
                    } else {
                        "".to_string()
                    }
                ))
                .bind(("start", start))
                .bind(("limit", BATCH_SIZE))
                .await?
                .take::<Vec<T>>(0)?;
            println!(
                "batch_event sending for table: {:?}, size: {:?}",
                table,
                data.len()
            );
            // dbg!(&initial_data);
            let batch_event = LiveQueryEvent {
                // subscription_id: live_query_uuid.to_string(),
                query_key: query_key.clone(),
                action: LiveQueryAction::BatchCreate,
                data: serde_json::to_string(&data)?,
            };
            batch_event.emit(&app)?;
            println!(
                "batch_event sent for table: {:?}, size: {:?}",
                table,
                data.len()
            );
            if data.len() < BATCH_SIZE as usize {
                break;
            }
            start += BATCH_SIZE;
        }

        let mut live_query = live_query.live().await?;
        println!("live query started");
        while let Some(notification) = live_query.next().await {
            // dbg!(&notification);
            if let Ok(Notification { action, data, .. }) = notification {
                let data = serde_json::to_string(&data)?;
                let event = LiveQueryEvent {
                    query_key: query_key.clone(),
                    action: match action {
                        Action::Create => LiveQueryAction::Create,
                        Action::Update => LiveQueryAction::Update,
                        Action::Delete => LiveQueryAction::Delete,
                        _ => return Err(anyhow::anyhow!("Invalid action")),
                    },
                    data,
                };
                event.emit(&app)?;
            }
        }
        println!("live query ended");
        Ok(())
    }

    pub async fn subscribe(
        &self,
        query_key: String,
        table: LiveQueryTable,
        range: Option<LiveQueryRange>,
        app: AppHandle,
    ) -> Result<()> {
        // let db: &surrealdb::Surreal<surrealdb::engine::any::Any> = db().await;
        println!("subscribe: {:?} {:?}", &table, &range);
        // Build query with bindings - use owned String directly

        return match table {
            LiveQueryTable::Chat => {
                self.subscribe_table::<DbChat>(query_key, range, "chat".to_string(), app)
                    .await
            }
            LiveQueryTable::BoardNote => {
                self.subscribe_table::<BoardNoteDb>(query_key, range, "board_note".to_string(), app)
                    .await
            }
            LiveQueryTable::Message => {
                self.subscribe_table::<DbMessage>(query_key, range, "message".to_string(), app)
                    .await
            }
        };
    }

    // pub async fn unsubscribe(&self, subscription_id: String) -> Result<()> {
    //     // Remove from map and abort the task first
    //     let abort_handle = {
    //         let mut subs = self.subscriptions.write().await;
    //         if let Some(state) = subs.remove(
    //             &Uuid::try_from(subscription_id.as_str())
    //                 .map_err(|_| anyhow::anyhow!("Invalid subscription ID format"))?,
    //         ) {
    //             Some(state.abort_handle)
    //         } else {
    //             None
    //         }
    //     };

    //     if let Some(handle) = abort_handle {
    //         handle.abort();
    //     }

    //     // Cancel the subscription in SurrealDB using query
    //     let db = db().await;
    //     let uuid = surrealdb::sql::Uuid::try_from(subscription_id.as_str())
    //         .map_err(|_| anyhow::anyhow!("Invalid subscription ID format"))?;
    //     let _ = db.query(format!("CANCEL {}", uuid)).await;

    //     Ok(())
    // }

    // pub async fn unsubscribe_all_for_query_key(&self, query_key: String) -> Result<()> {
    //     let mut subs = self.subscriptions.write().await;

    //     let to_remove: Vec<(Uuid, tokio::task::AbortHandle)> = subs
    //         .iter()
    //         .filter(|(_, sub)| *sub.query_key == query_key)
    //         .map(|(sid, state)| (sid.clone(), state.abort_handle.clone()))
    //         .collect();

    //     let db = db().await;
    //     for (uuid, abort_handle) in to_remove {
    //         let _ = db.query("CANCEL $uuid").bind(("uuid", uuid)).await?;
    //         abort_handle.abort();
    //     }

    //     subs.retain(|_, sub| *sub.query_key != query_key);

    //     Ok(())
    // }
}

// Global instance
static LIVE_QUERY_MANAGER: OnceCell<Arc<LiveQueryManager>> = OnceCell::const_new();

pub async fn get_manager() -> Arc<LiveQueryManager> {
    LIVE_QUERY_MANAGER
        .get_or_init(|| async { Arc::new(LiveQueryManager {}) })
        .await
        .clone()
}
