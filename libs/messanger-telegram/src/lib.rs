//! Telegram messenger client implementation for the universal messenger interface.
//!
//! This crate provides a Telegram-specific implementation of the `MessengerClient`
//! trait using the `grammers-client` library.

use async_trait::async_trait;
use grammers_client::{
    client::UpdatesConfiguration,
    peer::{Dialog, Peer},
    update::Update as TgUpdate,
    Client, SignInError,
};
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_session::updates::UpdatesLike;
use messanger_interface::session::SessionStoreWrapper;
use messanger_interface::{
    AuthConfig, ChatSummary, DialogStream, ExternalId, MessageStream, MessageSummary,
    MessengerClient, MessengerClientBuilder, MessengerError, NativePayload, SessionStore, Update,
    UpdateStream,
};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_stream::{self as stream};

use tokio::task::JoinHandle;

/// Telegram client implementation of the MessengerClient trait.
pub struct TelegramClient {
    pub client: Arc<Mutex<Client>>,
    #[allow(dead_code)]
    pub session: Arc<SqliteSession>,
    pub api_hash: String,
    #[allow(dead_code)]
    pub session_store: Option<Arc<dyn SessionStore + Send + Sync>>,
    pub updates_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<UpdatesLike>>>>,
    #[allow(dead_code)]
    pub pool_runner_handle: JoinHandle<()>,
}

impl TelegramClient {
    /// Get access to the underlying grammers Client for advanced operations
    /// like sending, editing, and deleting messages.
    pub async fn get_native_client(&self) -> Arc<Mutex<Client>> {
        self.client.clone()
    }
}

impl TelegramClient {
    /// Find a dialog by external ID using an already-locked client.
    /// This is used internally to avoid deadlocks when the caller already holds the lock.
    async fn find_dialog_with_client(
        client: &Client,
        chat_external_id: &ExternalId,
    ) -> Result<Dialog, MessengerError> {
        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if &dialog.peer().id().bare_id().to_string() == chat_external_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        found_dialog.ok_or_else(|| {
            MessengerError::NotFound(format!("Chat not found: {}", chat_external_id))
        })
    }

    async fn get_dialog(&self, chat_external_id: &ExternalId) -> Result<Dialog, MessengerError> {
        let client = self.client.lock().await;
        Self::find_dialog_with_client(&client, chat_external_id).await
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

    async fn login<'callback, F, Fut>(&self, prompt: F) -> Result<(), MessengerError>
    where
        F: Send + Sync + Fn(String) -> Fut + 'callback,
        Fut: std::future::Future<Output = Option<String>> + Send + 'callback,
    {
        let client = self.client.lock().await;
        let phone = prompt("Enter your phone number (international format): ".to_string())
            .await
            .ok_or(MessengerError::Authentication(
                "Failed to get phone number".to_string(),
            ))?;
        let token = client
            .request_login_code(&phone, &self.api_hash)
            .await
            .map_err(|_| {
                MessengerError::Authentication("Failed to request login code".to_string())
            })?;
        let code = prompt("Enter the code you received: ".to_string())
            .await
            .ok_or(MessengerError::Authentication(
                "Failed to get code".to_string(),
            ))?;
        let signed_in = client.sign_in(&token, &code).await;
        match signed_in {
            Err(SignInError::PasswordRequired(password_token)) => {
                // Note: this `prompt` method will echo the password in the console.
                //       Real code might want to use a better way to handle this.
                let hint = password_token.hint().unwrap_or("None");
                let prompt_message = format!("Enter the password (hint {}): ", &hint);
                let password =
                    prompt(prompt_message)
                        .await
                        .ok_or(MessengerError::Authentication(
                            "Failed to get password".to_string(),
                        ))?;

                client
                    .check_password(password_token, password.trim())
                    .await
                    .map_err(|_| {
                        MessengerError::Authentication("Failed to check password".to_string())
                    })?;
            }
            Ok(_) => (),
            Err(e) => {
                return Err(MessengerError::Authentication(format!(
                    "Sign in failed: {}",
                    e
                )))
            }
        };
        Ok(())
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
        let (sender, receiver) = tokio::sync::mpsc::channel(10);
        let data_stream = stream::wrappers::ReceiverStream::new(receiver);

        _ = tokio::spawn(async move {
            let client = client_arc.lock().await;
            let mut dialogs = client.iter_dialogs();
            while let Ok(Some(dialog)) = dialogs.next().await {
                let chat = dialog.peer();
                let summary = ChatSummary {
                    external_id: chat.id().bare_id().to_string(),
                    name: chat.name().map(|s| s.to_string()),
                    chat_type: Some(
                        match chat {
                            Peer::User(_) => "user",
                            Peer::Group(_) => "group",
                            Peer::Channel(_) => "channel",
                        }
                        .to_string(),
                    ),
                };
                sender
                    .send(Ok(summary))
                    .await
                    .expect("Failed to send dialog summary");
            }
        });

        Ok(Box::pin(data_stream))
    }

    async fn get_messages_count(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<usize, MessengerError> {
        let dialog = self.get_dialog(chat_external_id).await?;
        // Assign the lock to a variable so that the value lives long enough
        let client = self.client.clone();
        let client_lock = client.lock().await;
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let mut messages = client_lock.iter_messages(chat_ref);
        Ok(messages.total().await.map_err(|e| {
            MessengerError::Connection(format!("Failed to get messages count: {}", e))
        })?)
    }

    async fn iter_messages(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<MessageStream, MessengerError> {
        let client_arc = self.client.clone();

        let (sender, receiver) = tokio::sync::mpsc::channel(10);
        let data_stream = stream::wrappers::ReceiverStream::new(receiver);
        let client = client_arc.lock().await;
        let dialog = Self::find_dialog_with_client(&client, chat_external_id).await?;

        // Keep dialog alive while we use its chat
        let chat = dialog.peer().clone();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let mut messages = client.iter_messages(chat_ref);
        _ = tokio::spawn(async move {
            while let Ok(Some(msg)) = messages.next().await {
                // msg.sender() @todo add sender to message summary
                let summary = MessageSummary {
                    external_id: msg.id().to_string(),
                    chat_external_id: chat.id().bare_id().to_string(),
                    text: Some(msg.text().to_string()),
                    outgoing: msg.outgoing(),
                    timestamp_ms: Some(msg.date().timestamp_millis() as u64),
                    media_external_id: msg
                        .media()
                        .map(|_| format!("media:{}:{}", chat.id().bare_id(), msg.id())),
                };
                sender
                    .send(Ok(summary))
                    .await
                    .expect("Failed to send message summary");
            }
        });

        Ok(Box::pin(data_stream))
    }

    async fn iter_updates(&self) -> Result<UpdateStream, MessengerError> {
        // Take the updates receiver (can only be done once)
        let updates_rx = self.updates_rx.lock().await.take().ok_or_else(|| {
            MessengerError::Connection(
                "Updates stream already consumed. iter_updates can only be called once."
                    .to_string(),
            )
        })?;

        // Create updates configuration
        let config = UpdatesConfiguration {
            catch_up: false, // @tod maybe just on
            update_queue_limit: Some(100),
        };

        // Get the grammers update stream using stream_updates
        let client_guard = self.client.lock().await;
        let grammers_stream = client_guard.stream_updates(updates_rx, config);
        drop(client_guard);

        // Wrap the grammers UpdateStream (which has .next() method) into a futures Stream
        let stream = futures::stream::unfold(grammers_stream, |mut stream| async move {
            match stream.next().await {
                Ok(update) => {
                    let update_summary = match &update {
                        TgUpdate::NewMessage(message) => {
                            let chat_id = match message.peer() {
                                Some(chat) => chat.id().bare_id(),
                                None => message.peer_id().bare_id(),
                            };
                            Ok(Update::NewMessage(MessageSummary {
                                external_id: message.id().to_string(),
                                chat_external_id: chat_id.to_string(),
                                text: Some(message.text().to_string()),
                                outgoing: message.outgoing(),
                                timestamp_ms: Some(message.date().timestamp_millis() as u64),
                                media_external_id: message
                                    .media()
                                    .map(|_| format!("media:{}:{}", chat_id, message.id())),
                            }))
                        }
                        TgUpdate::MessageEdited(message) => {
                            let chat_id = match message.peer() {
                                Some(chat) => chat.id().bare_id(),
                                None => message.peer_id().bare_id(),
                            };
                            Ok(Update::MessageEdited(MessageSummary {
                                external_id: message.id().to_string(),
                                chat_external_id: chat_id.to_string(),
                                text: Some(message.text().to_string()),
                                outgoing: message.outgoing(),
                                timestamp_ms: Some(message.date().timestamp_millis() as u64),
                                media_external_id: message
                                    .media()
                                    .map(|_| format!("media:{}:{}", chat_id, message.id())),
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
                    Some((update_summary, stream))
                }
                Err(e) => Some((
                    Err(MessengerError::Connection(format!(
                        "Failed to get update: {}",
                        e
                    ))),
                    stream,
                )),
            }
        });

        Ok(Box::pin(stream))
    }

    async fn get_native_chat(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError> {
        let dialog = self.get_dialog(chat_external_id).await?;

        let chat = dialog.peer();
        // Use grammers-tl-types with serde feature for serialization
        return Ok(NativePayload {
            payload: match chat {
                Peer::User(user) => serde_json::to_value(&user.raw).map_err(|e| {
                    MessengerError::Serialization(format!("Failed to serialize user: {}", e))
                })?,
                Peer::Group(group) => serde_json::to_value(&group.raw).map_err(|e| {
                    MessengerError::Serialization(format!("Failed to serialize group: {}", e))
                })?,
                Peer::Channel(channel) => serde_json::to_value(&channel.raw).map_err(|e| {
                    MessengerError::Serialization(format!("Failed to serialize channel: {}", e))
                })?,
            },
        });
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
            if dialog.peer().id().bare_id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        let dialog = found_dialog
            .ok_or_else(|| MessengerError::NotFound(format!("Chat not found: {}", chat_id)))?;

        // Keep dialog alive while we use its chat
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let mut messages = client.iter_messages(chat_ref);
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
            if dialog.peer().id().bare_id() == chat_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        let dialog = found_dialog
            .ok_or_else(|| MessengerError::NotFound(format!("Chat not found: {}", chat_id)))?;

        // Keep dialog alive while we use its chat
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let mut messages = client.iter_messages(chat_ref);
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
        Ok(())
        // if let Some(session_store) = &self.session_store {
        //     let client = self.client.lock().await;
        //     // Serialize session to bytes via temp file
        //     let temp_path =
        //         std::env::temp_dir().join(format!("tg_session_save_{}.tmp", std::process::id()));
        //     {
        //         let session = client.
        //         session.save_to_file(&temp_path).map_err(|e| {
        //             MessengerError::Session(format!("Failed to save session: {}", e))
        //         })?;
        //     }
        //     let bytes = std::fs::read(&temp_path)
        //         .map_err(|e| MessengerError::Io(format!("Failed to read session file: {}", e)))?;
        //     let _ = std::fs::remove_file(&temp_path); // Try to clean up

        //     let session_json = serde_json::json!({
        //         "session_data": STANDARD.encode(&bytes)
        //     });

        //     session_store.save(&session_json).await?;
        //     Ok(())
        // } else {
        //     // No session store configured, but this is not an error
        //     Ok(())
        // }
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

        let dialog = Self::find_dialog_with_client(&client, chat_external_id).await?;
        let chat = dialog.peer();

        // Send the message
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let message = client
            .send_message(chat_ref, text)
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

        let dialog = Self::find_dialog_with_client(&client, chat_external_id).await?;
        let chat = dialog.peer();
        // Edit the message
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        client
            .edit_message(chat_ref, message_id, new_text)
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

        let dialog = Self::find_dialog_with_client(&client, chat_external_id).await?;
        let chat = dialog.peer();

        // Delete the message
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        client
            .delete_messages(chat_ref, &[message_id])
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

        // let api_hash = auth_config
        //     .credentials
        //     .get("api_hash")
        //     .and_then(|v| v.as_str())
        //     .ok_or_else(|| {
        //         MessengerError::Authentication("Missing api_hash in credentials".to_string())
        //     })?
        //     .to_string();

        // Create or load session
        let session = if let Some(store) = &session_store {
            if let Some(session_json) = store.load().await? {
                let session_file = session_json
                    .get("session_file")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        MessengerError::Serialization("Missing session_file field".to_string())
                    })?;
                // let session_data = session_json
                //     .get("session_data")
                //     .and_then(|v| v.as_str())
                //     .ok_or_else(|| {
                //         MessengerError::Serialization("Missing session_data field".to_string())
                //     })?;

                // let bytes = base64::engine::general_purpose::STANDARD
                //     .decode(session_data)
                //     .map_err(|e| {
                //         MessengerError::Serialization(format!("Failed to decode session: {}", e))
                //     })?;

                // Save bytes to temp file and load from file
                // let temp_path = std::env::temp_dir()
                //     .join(format!("tg_session_build_{}.tmp", std::process::id()));
                // std::fs::write(&temp_path, &bytes).map_err(|e| {
                //     MessengerError::Io(format!("Failed to write session file: {}", e))
                // })?;
                // let session = Session::load_file_or_create(&temp_path).map_err(|e| {
                //     let _ = std::fs::remove_file(&temp_path); // Try to clean up
                //     MessengerError::Session(format!("Failed to load session: {}", e))
                // })?;
                let session = SqliteSession::open(session_file).map_err(|e| {
                    MessengerError::Session(format!("Failed to open session: {}", e))
                })?;
                // if !session.signed_in() {
                //     return Err(MessengerError::Session("Session not signed in".to_string()));
                // }
                // let _ = std::fs::remove_file(&temp_path); // Try to clean up
                session
            } else {
                return Err(MessengerError::Session("Session not found".to_string()));
            }
        } else {
            return Err(MessengerError::Session(
                "Session store not provided".to_string(),
            ));
        };

        let session = Arc::new(session);
        let mut pool = SenderPool::new(session.clone(), api_id);

        // Extract the updates receiver before creating the client
        // We need to replace it with a dummy channel since Client::new needs to borrow the pool
        let (dummy_tx, dummy_rx) = mpsc::unbounded_channel();
        let updates_rx = std::mem::replace(&mut pool.updates, dummy_rx);
        drop(dummy_tx); // Close the dummy channel immediately
        let updates_rx = Arc::new(Mutex::new(Some(updates_rx)));

        let client = Client::new(&pool);
        let pool_runner_handle = tokio::spawn(pool.runner.run());

        // Store the session store if provided
        let stored_session_store = session_store
            .map(|s| Arc::new(SessionStoreWrapper(s)) as Arc<dyn SessionStore + Send + Sync>);
        client.is_authorized().await.map_err(|e| {
            MessengerError::Connection(format!("Failed to check authorization: {}", e))
        })?;
        let api_hash = auth_config
            .credentials
            .get("api_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                MessengerError::Authentication("Missing api_hash in credentials".to_string())
            })?
            .to_string();
        Ok(TelegramClient {
            client: Arc::new(Mutex::new(client)),
            session,
            api_hash,
            session_store: stored_session_store,
            updates_rx,
            pool_runner_handle,
        })
    }
}

impl Default for TelegramClientBuilder {
    fn default() -> Self {
        Self::new()
    }
}
