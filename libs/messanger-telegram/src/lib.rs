//! Telegram messenger client implementation for the universal messenger interface.
//!
//! This crate provides a Telegram-specific implementation of the `MessengerClient`
//! trait using the `grammers-client` library.

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use grammers_client::session::Session;
use grammers_client::types::{Chat, Message as TgMessage};
use grammers_client::{Client, Config, Update as TgUpdate};
use messanger_inteface::{
    AuthConfig, ChatSummary, DialogStream, ExternalId, MessageStream, MessageSummary,
    MessengerClient, MessengerClientBuilder, MessengerError, NativePayload, SessionStore, Update,
    UpdateStream,
};
use serde_json::Value as JsonValue;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_stream::{self as stream};

/// Session store adapter that bridges grammers Session and the SessionStore trait.
pub struct GrammersSessionStore {
    session: Arc<Mutex<Session>>,
}

/// Wrapper to convert Box<dyn SessionStore> to Arc<dyn SessionStore>
struct SessionStoreWrapper(Box<dyn SessionStore>);

#[async_trait]
impl SessionStore for SessionStoreWrapper {
    async fn load(&self) -> Result<Option<JsonValue>, MessengerError> {
        self.0.load().await
    }
    async fn save(&self, session: &JsonValue) -> Result<(), MessengerError> {
        self.0.save(session).await
    }
    async fn delete(&self) -> Result<(), MessengerError> {
        self.0.delete().await
    }
}

impl GrammersSessionStore {
    #[allow(dead_code)]
    fn new(session: Session) -> Self {
        Self {
            session: Arc::new(Mutex::new(session)),
        }
    }

    async fn get_session_bytes(&self) -> Result<Vec<u8>, MessengerError> {
        // Use a temporary file to save the session, then read it back
        let temp_path = std::env::temp_dir().join(format!("tg_session_{}.tmp", std::process::id()));
        {
            let session = self.session.lock().await;
            session
                .save_to_file(&temp_path)
                .map_err(|e| MessengerError::Session(format!("Failed to save session: {}", e)))?;
        }
        let bytes = std::fs::read(&temp_path)
            .map_err(|e| MessengerError::Io(format!("Failed to read session file: {}", e)))?;
        let _ = std::fs::remove_file(&temp_path); // Try to clean up, ignore errors
        Ok(bytes)
    }

    async fn set_session(&self, session: Session) {
        *self.session.lock().await = session;
    }
}

#[async_trait]
impl SessionStore for GrammersSessionStore {
    async fn load(&self) -> Result<Option<JsonValue>, MessengerError> {
        // Serialize session to bytes and encode as base64 JSON
        let bytes = self.get_session_bytes().await?;

        let session_json = serde_json::json!({
            "session_data": STANDARD.encode(&bytes)
        });

        Ok(Some(session_json))
    }

    async fn save(&self, session: &JsonValue) -> Result<(), MessengerError> {
        let session_data = session
            .get("session_data")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                MessengerError::Serialization("Missing session_data field".to_string())
            })?;

        let bytes = STANDARD.decode(session_data).map_err(|e| {
            MessengerError::Serialization(format!("Failed to decode session: {}", e))
        })?;

        // Save bytes to temp file and load from file
        let temp_path =
            std::env::temp_dir().join(format!("tg_session_load_{}.tmp", std::process::id()));
        std::fs::write(&temp_path, &bytes)
            .map_err(|e| MessengerError::Io(format!("Failed to write session file: {}", e)))?;
        let loaded_session = Session::load_file_or_create(&temp_path)
            .map_err(|e| MessengerError::Session(format!("Failed to load session: {}", e)))?;
        let _ = std::fs::remove_file(&temp_path); // Try to clean up

        self.set_session(loaded_session).await;
        Ok(())
    }

    async fn delete(&self) -> Result<(), MessengerError> {
        // Create a new empty session
        let new_session = Session::new();
        self.set_session(new_session).await;
        Ok(())
    }
}

/// Telegram client implementation of the MessengerClient trait.
pub struct TelegramClient {
    client: Arc<Mutex<Client>>,
    session_store: Option<Arc<dyn SessionStore + Send + Sync>>,
}

impl TelegramClient {
    /// Get access to the underlying grammers Client for advanced operations
    /// like sending, editing, and deleting messages.
    pub async fn get_native_client(&self) -> Arc<Mutex<Client>> {
        self.client.clone()
    }
}

#[async_trait]
impl MessengerClient for TelegramClient {
    async fn is_authorized(&self) -> Result<bool, MessengerError> {
        let client = self.client.lock().await;
        client.is_authorized().await.map_err(|e| {
            MessengerError::Connection(format!("Failed to check authorization: {}", e))
        })
    }

    async fn get_client_external_id(&self) -> Result<ExternalId, MessengerError> {
        let client = self.client.lock().await;
        let me = client
            .get_me()
            .await
            .map_err(|e| MessengerError::Connection(format!("Failed to get user info: {}", e)))?;

        let phone = me
            .phone()
            .ok_or_else(|| MessengerError::NotFound("Phone number not available".to_string()))?;

        Ok(format!("telegram:{}", phone))
    }

    async fn iter_dialogs(&self) -> Result<DialogStream, MessengerError> {
        let client_arc = self.client.clone();

        // Collect all dialogs first
        let mut dialogs_vec = Vec::new();
        {
            let client = client_arc.lock().await;
            let mut dialogs = client.iter_dialogs();
            while let Ok(Some(dialog)) = dialogs.next().await {
                let chat = dialog.chat();
                let summary = ChatSummary {
                    external_id: chat.id().to_string(),
                    name: chat.name().map(|s| s.to_string()),
                    chat_type: Some(
                        match chat {
                            Chat::User(_) => "user",
                            Chat::Group(_) => "group",
                            Chat::Channel(_) => "channel",
                        }
                        .to_string(),
                    ),
                };
                dialogs_vec.push(Ok(summary));
            }
        }

        let stream = stream::iter(dialogs_vec);
        Ok(Box::pin(stream))
    }

    async fn iter_messages(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<MessageStream, MessengerError> {
        let chat_id: i64 = chat_external_id
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid chat ID: {}", e)))?;

        let client_arc = self.client.clone();

        // Collect all messages - need to find chat within the lock and keep dialog alive
        let mut messages_vec = Vec::new();
        {
            let client = client_arc.lock().await;
            let mut dialogs = client.iter_dialogs();
            let mut found_dialog = None;
            while let Ok(Some(dialog)) = dialogs.next().await {
                if dialog.chat().id() == chat_id {
                    found_dialog = Some(dialog);
                    break;
                }
            }
            let dialog = found_dialog.ok_or_else(|| {
                MessengerError::NotFound(format!("Chat not found: {}", chat_external_id))
            })?;

            // Keep dialog alive while we use its chat
            let chat = dialog.chat();
            let mut messages = client.iter_messages(chat);
            while let Ok(Some(msg)) = messages.next().await {
                let summary = MessageSummary {
                    external_id: msg.id().to_string(),
                    chat_external_id: chat.id().to_string(),
                    text: Some(msg.text().to_string()),
                    outgoing: msg.outgoing(),
                    timestamp_ms: Some(msg.date().timestamp_millis() as u64),
                    media_external_id: msg
                        .media()
                        .map(|_| format!("media:{}:{}", chat.id(), msg.id())),
                };
                messages_vec.push(Ok(summary));
            }
        }

        let stream = stream::iter(messages_vec);
        Ok(Box::pin(stream))
    }

    async fn iter_updates(&self) -> Result<UpdateStream, MessengerError> {
        let client_arc = self.client.clone();

        // Create a stream that continuously polls for updates
        // We use a custom stream implementation since updates are infinite
        let stream = futures::stream::unfold(client_arc, |client| async move {
            let update = {
                let client_guard = client.lock().await;
                client_guard.next_update().await
            };

            match update {
                Ok(update) => {
                    let update_summary = match &update {
                        TgUpdate::NewMessage(message) => {
                            let chat = message.chat();
                            let msg: &TgMessage = message;
                            Ok(Update::NewMessage(MessageSummary {
                                external_id: msg.id().to_string(),
                                chat_external_id: chat.id().to_string(),
                                text: Some(msg.text().to_string()),
                                outgoing: msg.outgoing(),
                                timestamp_ms: Some(msg.date().timestamp_millis() as u64),
                                media_external_id: msg
                                    .media()
                                    .map(|_| format!("media:{}:{}", chat.id(), msg.id())),
                            }))
                        }
                        TgUpdate::MessageEdited(message) => {
                            let chat = message.chat();
                            let msg: &TgMessage = message;
                            Ok(Update::MessageEdited(MessageSummary {
                                external_id: msg.id().to_string(),
                                chat_external_id: chat.id().to_string(),
                                text: Some(msg.text().to_string()),
                                outgoing: msg.outgoing(),
                                timestamp_ms: Some(msg.date().timestamp_millis() as u64),
                                media_external_id: msg
                                    .media()
                                    .map(|_| format!("media:{}:{}", chat.id(), msg.id())),
                            }))
                        }
                        TgUpdate::MessageDeleted(deleted) => {
                            let channel_id = deleted.channel_id();
                            Ok(Update::MessageDeleted {
                                message_external_ids: deleted
                                    .messages()
                                    .iter()
                                    .map(|id| id.to_string())
                                    .collect(),
                                chat_external_id: channel_id.map(|id| id.to_string()),
                            })
                        }
                        other => {
                            // Update doesn't implement Serialize, so we'll create a minimal JSON representation
                            let update_type = format!("{:?}", std::mem::discriminant(other));
                            let payload = serde_json::to_value(other.raw()).unwrap_or_else(|e| {
                                serde_json::json!({
                                    "error": format!("Failed to serialize update: {}", e),
                                    "type": update_type.clone(),
                                })
                            });
                            Ok(Update::Other {
                                update_type,
                                payload,
                            })
                        }
                    };
                    Some((update_summary, client))
                }
                Err(e) => Some((
                    Err(MessengerError::Connection(format!(
                        "Failed to get update: {}",
                        e
                    ))),
                    client,
                )),
            }
        });

        Ok(Box::pin(stream))
    }

    async fn get_native_chat(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError> {
        let client = self.client.lock().await;
        let chat_id: i64 = chat_external_id
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid chat ID: {}", e)))?;

        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if dialog.chat().id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        if let Some(dialog) = found_dialog {
            let chat = dialog.chat();
            // Use grammers-tl-types with serde feature for serialization
            let payload = match chat {
                Chat::User(user) => {
                    // Access the inner TL type for serialization
                    serde_json::to_value(&user.raw).map_err(|e| {
                        MessengerError::Serialization(format!("Failed to serialize user: {}", e))
                    })?
                }
                Chat::Group(group) => serde_json::to_value(&group.raw).map_err(|e| {
                    MessengerError::Serialization(format!("Failed to serialize group: {}", e))
                })?,
                Chat::Channel(channel) => serde_json::to_value(&channel.raw).map_err(|e| {
                    MessengerError::Serialization(format!("Failed to serialize channel: {}", e))
                })?,
            };
            return Ok(NativePayload { payload });
        }

        Err(MessengerError::NotFound(format!(
            "Chat not found: {}",
            chat_external_id
        )))
    }

    async fn get_native_message(
        &self,
        message_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError> {
        // Parse message ID format: "chat_id:message_id"
        let parts: Vec<&str> = message_external_id.split(':').collect();
        if parts.len() < 2 {
            return Err(MessengerError::Serialization(format!(
                "Invalid message ID format: {}",
                message_external_id
            )));
        }

        let chat_id: i64 = parts[0]
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid chat ID: {}", e)))?;

        let message_id: i32 = parts[1]
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid message ID: {}", e)))?;

        let client = self.client.lock().await;

        // Find the dialog and keep it alive while we use its chat
        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if dialog.chat().id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        let dialog = found_dialog
            .ok_or_else(|| MessengerError::NotFound(format!("Chat not found: {}", chat_id)))?;

        // Keep dialog alive while we use its chat
        let chat = dialog.chat();
        let mut messages = client.iter_messages(chat);
        while let Ok(Some(msg)) = messages.next().await {
            if msg.id() == message_id {
                let payload = serde_json::to_value(&msg.raw).map_err(|e| {
                    MessengerError::Serialization(format!("Failed to serialize message: {}", e))
                })?;
                return Ok(NativePayload { payload });
            }
        }

        Err(MessengerError::NotFound(format!(
            "Message not found: {}",
            message_external_id
        )))
    }

    async fn get_native_media(
        &self,
        media_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError> {
        // Parse media ID format: "type:chat_id:message_id"
        let parts: Vec<&str> = media_external_id.split(':').collect();
        if parts.len() < 3 {
            return Err(MessengerError::Serialization(format!(
                "Invalid media ID format: {}",
                media_external_id
            )));
        }

        let chat_id: i64 = parts[1]
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid chat ID: {}", e)))?;

        let message_id: i32 = parts[2]
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid message ID: {}", e)))?;

        let client = self.client.lock().await;

        // Find the dialog and keep it alive while we use its chat
        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if dialog.chat().id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        let dialog = found_dialog
            .ok_or_else(|| MessengerError::NotFound(format!("Chat not found: {}", chat_id)))?;

        // Keep dialog alive while we use its chat
        let chat = dialog.chat();
        let mut messages = client.iter_messages(chat);
        while let Ok(Some(msg)) = messages.next().await {
            if msg.id() == message_id {
                if let Some(_media) = msg.media() {
                    // Media serialization is complex, create a placeholder
                    let payload = serde_json::json!({
                        "chat_id": chat_id,
                        "message_id": message_id,
                        "note": "Media details available via message"
                    });
                    return Ok(NativePayload { payload });
                } else {
                    return Err(MessengerError::NotFound(format!(
                        "Message {} has no media",
                        message_id
                    )));
                }
            }
        }

        Err(MessengerError::NotFound(format!(
            "Media not found: {}",
            media_external_id
        )))
    }

    async fn save_session(&self) -> Result<(), MessengerError> {
        if let Some(session_store) = &self.session_store {
            let client = self.client.lock().await;
            // Serialize session to bytes via temp file
            let temp_path =
                std::env::temp_dir().join(format!("tg_session_save_{}.tmp", std::process::id()));
            {
                let session = client.session();
                session.save_to_file(&temp_path).map_err(|e| {
                    MessengerError::Session(format!("Failed to save session: {}", e))
                })?;
            }
            let bytes = std::fs::read(&temp_path)
                .map_err(|e| MessengerError::Io(format!("Failed to read session file: {}", e)))?;
            let _ = std::fs::remove_file(&temp_path); // Try to clean up

            let session_json = serde_json::json!({
                "session_data": STANDARD.encode(&bytes)
            });

            session_store.save(&session_json).await?;
            Ok(())
        } else {
            // No session store configured, but this is not an error
            Ok(())
        }
    }

    async fn load_session(&self) -> Result<(), MessengerError> {
        // Session loading is handled during client creation in the builder
        // This method is kept for API compatibility but doesn't do anything
        // since we can't replace the session in an existing client
        Ok(())
    }

    async fn send_message(
        &self,
        chat_external_id: &ExternalId,
        text: &str,
    ) -> Result<ExternalId, MessengerError> {
        let client = self.client.lock().await;
        let chat_id: i64 = chat_external_id
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid chat ID: {}", e)))?;

        // Find the chat
        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if dialog.chat().id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        let dialog = found_dialog.ok_or_else(|| {
            MessengerError::NotFound(format!("Chat not found: {}", chat_external_id))
        })?;

        // Send the message
        let chat = dialog.chat();
        let message = client
            .send_message(chat, text)
            .await
            .map_err(|e| MessengerError::Connection(format!("Failed to send message: {}", e)))?;

        // Return external ID in format "chat_id:message_id"
        Ok(format!("{}:{}", chat_id, message.id()))
    }

    async fn edit_message(
        &self,
        chat_external_id: &ExternalId,
        message_external_id: &ExternalId,
        new_text: &str,
    ) -> Result<(), MessengerError> {
        let client = self.client.lock().await;
        let chat_id: i64 = chat_external_id
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid chat ID: {}", e)))?;

        // Parse message external ID format: "chat_id:message_id" or just "message_id"
        let message_id = if message_external_id.contains(':') {
            let parts: Vec<&str> = message_external_id.split(':').collect();
            if parts.len() >= 2 {
                parts[1].parse().map_err(|e| {
                    MessengerError::Serialization(format!("Invalid message ID: {}", e))
                })?
            } else {
                return Err(MessengerError::Serialization(format!(
                    "Invalid message ID format: {}",
                    message_external_id
                )));
            }
        } else {
            message_external_id
                .parse()
                .map_err(|e| MessengerError::Serialization(format!("Invalid message ID: {}", e)))?
        };

        // Find the chat
        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if dialog.chat().id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        let dialog = found_dialog.ok_or_else(|| {
            MessengerError::NotFound(format!("Chat not found: {}", chat_external_id))
        })?;

        // Edit the message
        let chat = dialog.chat();
        client
            .edit_message(chat, message_id, new_text)
            .await
            .map_err(|e| MessengerError::Connection(format!("Failed to edit message: {}", e)))?;

        Ok(())
    }

    async fn delete_message(
        &self,
        chat_external_id: &ExternalId,
        message_external_id: &ExternalId,
    ) -> Result<(), MessengerError> {
        let client = self.client.lock().await;
        let chat_id: i64 = chat_external_id
            .parse()
            .map_err(|e| MessengerError::Serialization(format!("Invalid chat ID: {}", e)))?;

        // Parse message external ID format: "chat_id:message_id" or just "message_id"
        let message_id = if message_external_id.contains(':') {
            let parts: Vec<&str> = message_external_id.split(':').collect();
            if parts.len() >= 2 {
                parts[1].parse().map_err(|e| {
                    MessengerError::Serialization(format!("Invalid message ID: {}", e))
                })?
            } else {
                return Err(MessengerError::Serialization(format!(
                    "Invalid message ID format: {}",
                    message_external_id
                )));
            }
        } else {
            message_external_id
                .parse()
                .map_err(|e| MessengerError::Serialization(format!("Invalid message ID: {}", e)))?
        };

        // Find the chat
        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if dialog.chat().id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        let dialog = found_dialog.ok_or_else(|| {
            MessengerError::NotFound(format!("Chat not found: {}", chat_external_id))
        })?;

        // Delete the message
        let chat = dialog.chat();
        client
            .delete_messages(chat, &[message_id])
            .await
            .map_err(|e| MessengerError::Connection(format!("Failed to delete message: {}", e)))?;

        Ok(())
    }
}

/// Builder for creating Telegram clients.
pub struct TelegramClientBuilder;

impl TelegramClientBuilder {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl MessengerClientBuilder for TelegramClientBuilder {
    type Client = TelegramClient;

    async fn build(
        &self,
        auth_config: AuthConfig,
        session_store: Option<Box<dyn SessionStore>>,
    ) -> Result<Self::Client, MessengerError> {
        let api_id = auth_config
            .credentials
            .get("api_id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| {
                MessengerError::Authentication("Missing api_id in credentials".to_string())
            })? as i32;

        let api_hash = auth_config
            .credentials
            .get("api_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                MessengerError::Authentication("Missing api_hash in credentials".to_string())
            })?
            .to_string();

        // Create or load session
        let session = if let Some(store) = &session_store {
            if let Some(session_json) = store.load().await? {
                let session_data = session_json
                    .get("session_data")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        MessengerError::Serialization("Missing session_data field".to_string())
                    })?;

                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(session_data)
                    .map_err(|e| {
                        MessengerError::Serialization(format!("Failed to decode session: {}", e))
                    })?;

                // Save bytes to temp file and load from file
                let temp_path = std::env::temp_dir()
                    .join(format!("tg_session_build_{}.tmp", std::process::id()));
                std::fs::write(&temp_path, &bytes).map_err(|e| {
                    MessengerError::Io(format!("Failed to write session file: {}", e))
                })?;
                let session = Session::load_file_or_create(&temp_path).map_err(|e| {
                    let _ = std::fs::remove_file(&temp_path); // Try to clean up
                    MessengerError::Session(format!("Failed to load session: {}", e))
                })?;
                if !session.signed_in() {
                    return Err(MessengerError::Session("Session not signed in".to_string()));
                }
                let _ = std::fs::remove_file(&temp_path); // Try to clean up
                session
            } else {
                return Err(MessengerError::Session("Session not found".to_string()));
            }
        } else {
            return Err(MessengerError::Session(
                "Session store not provided".to_string(),
            ));
        };

        // Create client
        let client = Client::connect(Config {
            session,
            api_id,
            api_hash,
            params: Default::default(),
        })
        .await
        .map_err(|e| MessengerError::Connection(format!("Failed to connect: {}", e)))?;

        // Store the session store if provided
        let stored_session_store = session_store
            .map(|s| Arc::new(SessionStoreWrapper(s)) as Arc<dyn SessionStore + Send + Sync>);
        client.is_authorized().await.map_err(|e| {
            MessengerError::Connection(format!("Failed to check authorization: {}", e))
        })?;
        Ok(TelegramClient {
            client: Arc::new(Mutex::new(client)),
            session_store: stored_session_store,
        })
    }
}

impl Default for TelegramClientBuilder {
    fn default() -> Self {
        Self::new()
    }
}
