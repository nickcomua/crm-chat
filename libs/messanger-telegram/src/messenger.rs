//! MessengerClient trait implementation for TelegramClient.

use async_stream::stream;
use async_trait::async_trait;
use grammers_client::{
    client::UpdatesConfiguration,
    media::{Downloadable, Media},
    peer::{Dialog, Peer},
    update::Update as TgUpdate,
    Client,
};
use grammers_tl_types as tl;
use messanger_interface::{
    ChatSummary, DialogStream, ExternalId, MediaKind, MediaSummary, MessageStream, MessageSummary,
    MessengerClient, MessengerError, NativePayload, Update, UpdateStream,
};
use tokio_stream as tokio_stream_wrappers;
use tracing::{debug, error, info, instrument, trace, warn};

use crate::TelegramClient;

/// Classify a grammers `Media` into our `MediaSummary` with type and metadata.
fn classify_media(media: &Media, chat_id: i64, msg_id: i32) -> Option<MediaSummary> {
    let external_id = format!("media:{}:{}", chat_id, msg_id);

    match media {
        Media::Photo(photo) => {
            let thumbs = photo.thumbs();
            let largest = thumbs.iter().max_by_key(|t| t.size());
            // Extract dimensions from the largest thumbnail via pattern matching.
            // PhotoSize inner structs aren't re-exported, but we can destructure the variants.
            let (width, height) = largest
                .and_then(|t| {
                    use grammers_client::media::PhotoSize;
                    match t {
                        PhotoSize::Size(s) => Some((s.width, s.height)),
                        PhotoSize::Progressive(s) => Some((s.width, s.height)),
                        PhotoSize::Cached(s) => Some((s.width, s.height)),
                        _ => None,
                    }
                })
                .unwrap_or((0, 0));

            Some(MediaSummary {
                external_id,
                kind: MediaKind::Photo,
                url: None,
                metadata: None,
                mime_type: Some("image/jpeg".to_string()),
                file_name: None,
                file_size: photo.size(),
                width: if width > 0 { Some(width) } else { None },
                height: if height > 0 { Some(height) } else { None },
                duration: None,
            })
        }
        Media::Sticker(sticker) => {
            let doc = &sticker.document;
            Some(MediaSummary {
                external_id,
                kind: MediaKind::Sticker,
                url: None,
                metadata: None,
                mime_type: doc.mime_type().map(String::from),
                file_name: doc.name().map(String::from),
                file_size: doc.size(),
                width: doc.resolution().map(|(w, _)| w),
                height: doc.resolution().map(|(_, h)| h),
                duration: None,
            })
        }
        Media::Document(doc) => {
            // Classify by top-level flags on MessageMediaDocument
            let kind = if doc.raw.voice {
                MediaKind::Voice
            } else if doc.raw.round {
                MediaKind::VideoNote
            } else if doc.raw.video {
                if doc.is_animated() {
                    MediaKind::Animation
                } else {
                    MediaKind::Video
                }
            } else if doc.is_animated() {
                MediaKind::Animation
            } else if doc
                .mime_type()
                .is_some_and(|m| m.starts_with("audio/"))
            {
                MediaKind::Audio
            } else {
                MediaKind::Document
            };

            let (width, height) = doc
                .resolution()
                .map(|(w, h)| (Some(w), Some(h)))
                .unwrap_or((None, None));

            Some(MediaSummary {
                external_id,
                kind,
                url: None,
                metadata: None,
                mime_type: doc.mime_type().map(String::from),
                file_name: doc.name().map(String::from),
                file_size: doc.size(),
                width,
                height,
                duration: doc.duration(),
            })
        }
        // Non-downloadable types (Contact, Poll, Geo, Dice, Venue, GeoLive, WebPage)
        _ => None,
    }
}

impl TelegramClient {
    /// Download media bytes from Telegram.
    pub async fn download_media(
        &self,
        downloadable: &impl Downloadable,
    ) -> Result<Vec<u8>, MessengerError> {
        let client = self.client.lock().await;
        let mut download = client.iter_download(downloadable);
        let mut bytes = Vec::new();
        while let Some(chunk) = download.next().await.map_err(|e| {
            MessengerError::Connection(format!("Failed to download media chunk: {}", e))
        })? {
            bytes.extend(chunk);
        }
        Ok(bytes)
    }

    /// Get the grammers Media object from a message by chat+message IDs.
    /// Used by the background download task to re-fetch media for pending records.
    ///
    /// Uses `offset_id` to jump directly to the message instead of iterating
    /// through the entire chat history (which could be thousands of API calls).
    pub async fn get_message_media(
        &self,
        chat_external_id: &str,
        message_id: i32,
    ) -> Result<Option<Media>, MessengerError> {
        let client = self.client.lock().await;
        let dialog = Self::find_dialog_with_client(&client, &chat_external_id.to_string()).await?;
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;

        // offset_id returns messages with IDs < offset, so offset_id(msg + 1)
        // starts right at the target message.
        let mut messages = client.iter_messages(chat_ref).offset_id(message_id + 1);
        if let Ok(Some(msg)) = messages.next().await {
            if msg.id() == message_id {
                return Ok(msg.media());
            }
        }

        Ok(None)
    }

    /// Stream-download media for a message, sending chunks through a channel.
    ///
    /// Returns `Ok(None)` if the message has no media, or `Ok(Some(total_bytes))`
    /// after all chunks have been sent through `chunk_tx`. The caller typically
    /// feeds the receiver side into a streaming HTTP upload (e.g. reqwest
    /// `Body::wrap_stream`) so the file never sits fully in memory.
    pub async fn stream_message_media(
        &self,
        chat_external_id: &str,
        message_id: i32,
        chunk_tx: tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
    ) -> Result<Option<usize>, MessengerError> {
        // Perform lookup + download under a single lock acquisition to avoid
        // deadlocking (get_message_media and iter_download both need the lock).
        let client = self.client.lock().await;
        let dialog = Self::find_dialog_with_client(&client, &chat_external_id.to_string()).await?;
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;

        // Use offset_id for efficient O(1) lookup.
        let mut messages = client.iter_messages(chat_ref).offset_id(message_id + 1);
        let media = match messages.next().await {
            Ok(Some(msg)) if msg.id() == message_id => match msg.media() {
                Some(m) => m,
                None => return Ok(None),
            },
            _ => return Ok(None),
        };

        let mut download = client.iter_download(&media);
        let mut total = 0usize;
        while let Some(chunk) = download.next().await.map_err(|e| {
            MessengerError::Connection(format!("Failed to download media chunk: {}", e))
        })? {
            total += chunk.len();
            chunk_tx.send(Ok(chunk)).await.map_err(|_| {
                MessengerError::Connection("Upload receiver dropped".to_string())
            })?;
        }

        Ok(Some(total))
    }

    /// Find a dialog by external ID using an already-locked client.
    /// This is used internally to avoid deadlocks when the caller already holds the lock.
    pub(crate) async fn find_dialog_with_client(
        client: &Client,
        chat_external_id: &ExternalId,
    ) -> Result<Dialog, MessengerError> {
        trace!(chat_external_id = %chat_external_id, "Searching for dialog");
        let mut dialogs = client.iter_dialogs();
        let mut found_dialog = None;
        while let Ok(Some(dialog)) = dialogs.next().await {
            if &dialog.peer().id().bare_id().to_string() == chat_external_id {
                found_dialog = Some(dialog);
                break;
            }
        }
        found_dialog.ok_or_else(|| {
            warn!(chat_external_id = %chat_external_id, "Chat not found");
            MessengerError::NotFound(format!("Chat not found: {}", chat_external_id))
        })
    }

    pub(crate) async fn get_dialog(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<Dialog, MessengerError> {
        let client = self.client.lock().await;
        Self::find_dialog_with_client(&client, chat_external_id).await
    }
}

#[async_trait]
impl MessengerClient for TelegramClient {
    #[instrument(skip(self))]
    async fn is_authorized(&self) -> Result<bool, MessengerError> {
        debug!("Checking authorization status");
        let client = self.client.lock().await;
        let result = client.is_authorized().await.map_err(|e| {
            error!(error = %e, "Failed to check authorization");
            MessengerError::Connection(format!("Failed to check authorization: {}", e))
        })?;
        debug!(authorized = result, "Authorization check complete");
        Ok(result)
    }

    #[instrument(skip(self))]
    async fn get_client_external_id(&self) -> Result<ExternalId, MessengerError> {
        debug!("Getting client external ID");
        let client = self.client.lock().await;
        let me = client.get_me().await.map_err(|e| {
            error!(error = %e, "Failed to get user info");
            MessengerError::Connection(format!("Failed to get user info: {}", e))
        })?;

        let phone = me.phone().ok_or_else(|| {
            warn!("Phone number not available for client");
            MessengerError::NotFound("Phone number not available".to_string())
        })?;

        let external_id = format!("telegram:{}", phone);
        debug!(external_id = %external_id, "Got client external ID");
        Ok(external_id)
    }

    #[instrument(skip(self))]
    async fn iter_dialogs(&self) -> Result<DialogStream, MessengerError> {
        info!("Starting dialog iteration");
        let client_arc = self.client.clone();
        let (sender, receiver) = tokio::sync::mpsc::channel(10);
        let data_stream = tokio_stream_wrappers::wrappers::ReceiverStream::new(receiver);

        tokio::spawn(async move {
            let client = client_arc.lock().await;
            let mut dialogs = client.iter_dialogs();
            let mut count = 0;
            while let Ok(Some(dialog)) = dialogs.next().await {
                let chat = dialog.peer();
                let is_pinned = match &dialog.raw {
                    tl::enums::Dialog::Dialog(d) => d.pinned,
                    tl::enums::Dialog::Folder(d) => d.pinned,
                };
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
                    is_pinned,
                };
                count += 1;
                // If receiver is dropped, stop producing to avoid unnecessary work
                if sender.send(Ok(summary)).await.is_err() {
                    debug!(count = count, "Dialog receiver dropped, stopping iteration");
                    break;
                }
            }
            debug!(total_dialogs = count, "Dialog iteration complete");
        });

        Ok(Box::pin(data_stream))
    }

    #[instrument(skip(self), fields(chat_id = %chat_external_id))]
    async fn get_messages_count(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<usize, MessengerError> {
        debug!("Getting messages count");
        let dialog = self.get_dialog(chat_external_id).await?;
        // Assign the lock to a variable so that the value lives long enough
        let client = self.client.clone();
        let client_lock = client.lock().await;
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            error!(chat_id = %chat.id().bare_id(), "Could not get chat reference");
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let mut messages = client_lock.iter_messages(chat_ref);
        let count = messages.total().await.map_err(|e| {
            error!(error = %e, "Failed to get messages count");
            MessengerError::Connection(format!("Failed to get messages count: {}", e))
        })?;
        debug!(count = count, "Got messages count");
        Ok(count)
    }

    #[instrument(skip(self), fields(chat_id = %chat_external_id))]
    async fn iter_messages(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<MessageStream, MessengerError> {
        info!("Starting message iteration");
        let client_arc = self.client.clone();
        let chat_external_id = chat_external_id.clone();

        let (sender, receiver) = tokio::sync::mpsc::channel(10);
        let data_stream = tokio_stream_wrappers::wrappers::ReceiverStream::new(receiver);

        tokio::spawn(async move {
            let client = client_arc.lock().await;
            let dialog = match Self::find_dialog_with_client(&client, &chat_external_id).await {
                Ok(d) => d,
                Err(e) => {
                    sender.send(Err(e)).await.ok();
                    return;
                }
            };

            // Keep dialog alive while we use its chat
            let chat = dialog.peer().clone();
            let chat_ref = match chat.to_ref() {
                Some(r) => r,
                None => {
                    error!(chat_id = %chat.id().bare_id(), "Could not get chat reference");
                    sender
                        .send(Err(MessengerError::NotFound(format!(
                            "Could not get reference for chat: {}",
                            chat.id().bare_id()
                        ))))
                        .await
                        .ok();
                    return;
                }
            };

            let mut messages = client.iter_messages(chat_ref);
            let mut count = 0;
            while let Ok(Some(msg)) = messages.next().await {
                if let Some(sender_id) = msg.sender_id() {
                    let chat_bare_id = chat.id().bare_id();
                    let media_summary = msg.media().and_then(|m| classify_media(&m, chat_bare_id, msg.id()));
                    let summary = MessageSummary {
                        external_id: msg.id().to_string(),
                        chat_external_id: chat_bare_id.to_string(),
                        text: Some(msg.text().to_string()),
                        sender_id: sender_id.to_string(),
                        outgoing: msg.outgoing(),
                        timestamp_ms: Some(msg.date().timestamp_millis() as u64),
                        media_external_id: msg
                            .media()
                            .map(|_| format!("media:{}:{}", chat_bare_id, msg.id())),
                        media_summary,
                    };
                    count += 1;
                    // If receiver is dropped, stop producing to avoid unnecessary work
                    if sender.send(Ok(summary)).await.is_err() {
                        debug!(
                            count = count,
                            "Message receiver dropped, stopping iteration"
                        );
                        break;
                    }
                } else {
                    trace!(message_id = msg.id(), "Message without sender");
                    sender
                        .send(Err(MessengerError::NotFound(
                            "Sender not found".to_string(),
                        )))
                        .await
                        .ok();
                }
            }
            debug!(total_messages = count, "Message iteration complete");
        });

        Ok(Box::pin(data_stream))
    }

    #[instrument(skip(self))]
    async fn iter_updates(&self) -> Result<UpdateStream, MessengerError> {
        info!("Starting updates stream");
        // Take the updates receiver (can only be done once)
        let updates_rx = self.updates_rx.lock().await.take().ok_or_else(|| {
            error!("Updates stream already consumed");
            MessengerError::Connection(
                "Updates stream already consumed. iter_updates can only be called once."
                    .to_string(),
            )
        })?;

        // Create updates configuration
        let config = UpdatesConfiguration {
            catch_up: true,
            update_queue_limit: Some(10_000),
        };

        // Get the grammers update stream using stream_updates
        let client_guard = self.client.lock().await;
        let mut grammers_stream = client_guard.stream_updates(updates_rx, config);
        drop(client_guard);

        debug!("Updates stream initialized");

        let update_stream = stream! {
            loop {
                match grammers_stream.next().await {
                    Ok(update) => {
                        let update_summary = match &update {
                            TgUpdate::NewMessage(message) => {
                                let chat_id = match message.peer() {
                                    Some(chat) => chat.id().bare_id(),
                                    None => message.peer_id().bare_id(),
                                };
                                let sender_id = message
                                    .sender_id()
                                    .map(|id| id.to_string())
                                    .unwrap_or_default();
                                trace!(
                                    message_id = message.id(),
                                    chat_id = chat_id,
                                    "Received new message update"
                                );
                                let media_summary = message.media().and_then(|m| classify_media(&m, chat_id, message.id()));
                                Update::NewMessage(MessageSummary {
                                    external_id: message.id().to_string(),
                                    chat_external_id: chat_id.to_string(),
                                    sender_id,
                                    text: Some(message.text().to_string()),
                                    outgoing: message.outgoing(),
                                    timestamp_ms: Some(message.date().timestamp_millis() as u64),
                                    media_external_id: message
                                        .media()
                                        .map(|_| format!("media:{}:{}", chat_id, message.id())),
                                    media_summary,
                                })
                            }
                            TgUpdate::MessageEdited(message) => {
                                let chat_id = match message.peer() {
                                    Some(chat) => chat.id().bare_id(),
                                    None => message.peer_id().bare_id(),
                                };
                                let sender_id = message
                                    .sender_id()
                                    .map(|id| id.to_string())
                                    .unwrap_or_default();
                                trace!(
                                    message_id = message.id(),
                                    chat_id = chat_id,
                                    "Received message edited update"
                                );
                                let media_summary = message.media().and_then(|m| classify_media(&m, chat_id, message.id()));
                                Update::MessageEdited(MessageSummary {
                                    external_id: message.id().to_string(),
                                    chat_external_id: chat_id.to_string(),
                                    sender_id,
                                    text: Some(message.text().to_string()),
                                    outgoing: message.outgoing(),
                                    timestamp_ms: Some(message.date().timestamp_millis() as u64),
                                    media_external_id: message
                                        .media()
                                        .map(|_| format!("media:{}:{}", chat_id, message.id())),
                                    media_summary,
                                })
                            }
                            TgUpdate::MessageDeleted(deleted) => {
                                let channel_id = deleted.channel_id();
                                trace!(
                                    message_count = deleted.messages().len(),
                                    "Received message deleted update"
                                );
                                Update::MessageDeleted {
                                    message_external_ids: deleted
                                        .messages()
                                        .iter()
                                        .map(|id| id.to_string())
                                        .collect(),
                                    chat_external_id: channel_id.map(|id| id.to_string()),
                                }
                            }
                            other => {
                                // Update doesn't implement Serialize, so we'll create a minimal JSON representation
                                let update_type = format!("{:?}", std::mem::discriminant(other));
                                trace!(update_type = %update_type, "Received other update type");
                                let payload = serde_json::to_value(other.raw()).unwrap_or_else(|e| {
                                    serde_json::json!({
                                        "error": format!("Failed to serialize update: {}", e),
                                        "type": update_type.clone(),
                                    })
                                });
                                Update::Other {
                                    update_type,
                                    payload,
                                }
                            }
                        };
                        yield Ok(update_summary);
                    }
                    Err(e) => {
                        error!(error = %e, "Failed to get update from stream");
                        yield Err(MessengerError::Connection(format!(
                            "Failed to get update: {}",
                            e
                        )));
                    }
                }
            }
        };

        Ok(Box::pin(update_stream))
    }

    #[instrument(skip(self), fields(chat_id = %chat_external_id))]
    async fn get_native_chat(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError> {
        debug!("Getting native chat");
        let dialog = self.get_dialog(chat_external_id).await?;

        let chat = dialog.peer();
        // Use grammers-tl-types with serde feature for serialization
        let payload = match chat {
            Peer::User(user) => {
                debug!("Serializing user chat");
                serde_json::to_value(&user.raw).map_err(|e| {
                    error!(error = %e, "Failed to serialize user");
                    MessengerError::Serialization(format!("Failed to serialize user: {}", e))
                })?
            }
            Peer::Group(group) => {
                debug!("Serializing group chat");
                serde_json::to_value(&group.raw).map_err(|e| {
                    error!(error = %e, "Failed to serialize group");
                    MessengerError::Serialization(format!("Failed to serialize group: {}", e))
                })?
            }
            Peer::Channel(channel) => {
                debug!("Serializing channel chat");
                serde_json::to_value(&channel.raw).map_err(|e| {
                    error!(error = %e, "Failed to serialize channel");
                    MessengerError::Serialization(format!("Failed to serialize channel: {}", e))
                })?
            }
        };
        Ok(NativePayload { payload })
    }

    #[instrument(skip(self), fields(message_id = %message_external_id))]
    async fn get_native_message(
        &self,
        message_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError> {
        debug!("Getting native message");
        // Parse message ID format: "chat_id:message_id"
        let parts: Vec<&str> = message_external_id.split(':').collect();
        if parts.len() < 2 {
            error!("Invalid message ID format");
            return Err(MessengerError::Serialization(format!(
                "Invalid message ID format: {}",
                message_external_id
            )));
        }

        let chat_id: i64 = parts[0].parse().map_err(|e| {
            error!(error = %e, "Invalid chat ID");
            MessengerError::Serialization(format!("Invalid chat ID: {}", e))
        })?;

        let message_id: i32 = parts[1].parse().map_err(|e| {
            error!(error = %e, "Invalid message ID");
            MessengerError::Serialization(format!("Invalid message ID: {}", e))
        })?;

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
        let dialog = found_dialog.ok_or_else(|| {
            warn!(chat_id = chat_id, "Chat not found");
            MessengerError::NotFound(format!("Chat not found: {}", chat_id))
        })?;

        // Keep dialog alive while we use its chat
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            error!(chat_id = %chat.id().bare_id(), "Could not get chat reference");
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let mut messages = client.iter_messages(chat_ref);
        while let Ok(Some(msg)) = messages.next().await {
            if msg.id() == message_id {
                let payload = serde_json::to_value(&msg.raw).map_err(|e| {
                    error!(error = %e, "Failed to serialize message");
                    MessengerError::Serialization(format!("Failed to serialize message: {}", e))
                })?;
                debug!("Found and serialized message");
                return Ok(NativePayload { payload });
            }
        }

        warn!(message_id = message_id, "Message not found");
        Err(MessengerError::NotFound(format!(
            "Message not found: {}",
            message_external_id
        )))
    }

    #[instrument(skip(self), fields(media_id = %media_external_id))]
    async fn get_native_media(
        &self,
        media_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError> {
        debug!("Getting native media");
        // Parse media ID format: "type:chat_id:message_id"
        let parts: Vec<&str> = media_external_id.split(':').collect();
        if parts.len() < 3 {
            error!("Invalid media ID format");
            return Err(MessengerError::Serialization(format!(
                "Invalid media ID format: {}",
                media_external_id
            )));
        }

        let chat_id: i64 = parts[1].parse().map_err(|e| {
            error!(error = %e, "Invalid chat ID");
            MessengerError::Serialization(format!("Invalid chat ID: {}", e))
        })?;

        let message_id: i32 = parts[2].parse().map_err(|e| {
            error!(error = %e, "Invalid message ID");
            MessengerError::Serialization(format!("Invalid message ID: {}", e))
        })?;

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
        let dialog = found_dialog.ok_or_else(|| {
            warn!(chat_id = chat_id, "Chat not found");
            MessengerError::NotFound(format!("Chat not found: {}", chat_id))
        })?;

        // Keep dialog alive while we use its chat
        let chat = dialog.peer();
        let chat_ref = chat.to_ref().ok_or_else(|| {
            error!(chat_id = %chat.id().bare_id(), "Could not get chat reference");
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let mut messages = client.iter_messages(chat_ref);
        while let Ok(Some(msg)) = messages.next().await {
            if msg.id() == message_id {
                if msg.media().is_some() {
                    debug!("Found media in message");
                    // Media serialization is complex, create a placeholder
                    let payload = serde_json::json!({
                        "chat_id": chat_id,
                        "message_id": message_id,
                        "note": "Media details available via message"
                    });
                    return Ok(NativePayload { payload });
                } else {
                    warn!(message_id = message_id, "Message has no media");
                    return Err(MessengerError::NotFound(format!(
                        "Message {} has no media",
                        message_id
                    )));
                }
            }
        }

        warn!(media_id = %media_external_id, "Media not found");
        Err(MessengerError::NotFound(format!(
            "Media not found: {}",
            media_external_id
        )))
    }

    #[instrument(skip(self))]
    async fn save_session(&self) -> Result<(), MessengerError> {
        debug!("Save session called (no-op)");
        Ok(())
    }

    #[instrument(skip(self))]
    async fn load_session(&self) -> Result<(), MessengerError> {
        // Session loading is handled during client creation in the builder
        // This method is kept for API compatibility but doesn't do anything
        // since we can't replace the session in an existing client
        debug!("Load session called (no-op)");
        Ok(())
    }

    #[instrument(skip(self, text), fields(chat_id = %chat_external_id, text_len = text.len()))]
    async fn send_message(
        &self,
        chat_external_id: &ExternalId,
        text: &str,
    ) -> Result<ExternalId, MessengerError> {
        info!("Sending message");
        let client = self.client.lock().await;
        let chat_id: i64 = chat_external_id.parse().map_err(|e| {
            error!(error = %e, "Invalid chat ID");
            MessengerError::Serialization(format!("Invalid chat ID: {}", e))
        })?;

        let dialog = Self::find_dialog_with_client(&client, chat_external_id).await?;
        let chat = dialog.peer();

        // Send the message
        let chat_ref = chat.to_ref().ok_or_else(|| {
            error!(chat_id = %chat.id().bare_id(), "Could not get chat reference");
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        let message = client.send_message(chat_ref, text).await.map_err(|e| {
            error!(error = %e, "Failed to send message");
            MessengerError::Connection(format!("Failed to send message: {}", e))
        })?;

        let external_id = format!("{}:{}", chat_id, message.id());
        info!(message_id = message.id(), "Message sent successfully");
        Ok(external_id)
    }

    #[instrument(skip(self, new_text), fields(chat_id = %chat_external_id, message_id = %message_external_id))]
    async fn edit_message(
        &self,
        chat_external_id: &ExternalId,
        message_external_id: &ExternalId,
        new_text: &str,
    ) -> Result<(), MessengerError> {
        info!("Editing message");
        let client = self.client.lock().await;

        // Parse message external ID format: "chat_id:message_id" or just "message_id"
        let message_id = if message_external_id.contains(':') {
            let parts: Vec<&str> = message_external_id.split(':').collect();
            if parts.len() >= 2 {
                parts[1].parse().map_err(|e| {
                    error!(error = %e, "Invalid message ID");
                    MessengerError::Serialization(format!("Invalid message ID: {}", e))
                })?
            } else {
                error!("Invalid message ID format");
                return Err(MessengerError::Serialization(format!(
                    "Invalid message ID format: {}",
                    message_external_id
                )));
            }
        } else {
            message_external_id.parse().map_err(|e| {
                error!(error = %e, "Invalid message ID");
                MessengerError::Serialization(format!("Invalid message ID: {}", e))
            })?
        };

        let dialog = Self::find_dialog_with_client(&client, chat_external_id).await?;
        let chat = dialog.peer();
        // Edit the message
        let chat_ref = chat.to_ref().ok_or_else(|| {
            error!(chat_id = %chat.id().bare_id(), "Could not get chat reference");
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        client
            .edit_message(chat_ref, message_id, new_text)
            .await
            .map_err(|e| {
                error!(error = %e, "Failed to edit message");
                MessengerError::Connection(format!("Failed to edit message: {}", e))
            })?;

        info!("Message edited successfully");
        Ok(())
    }

    #[instrument(skip(self), fields(chat_id = %chat_external_id, message_id = %message_external_id))]
    async fn delete_message(
        &self,
        chat_external_id: &ExternalId,
        message_external_id: &ExternalId,
    ) -> Result<(), MessengerError> {
        info!("Deleting message");
        let client = self.client.lock().await;

        // Parse message external ID format: "chat_id:message_id" or just "message_id"
        let message_id = if message_external_id.contains(':') {
            let parts: Vec<&str> = message_external_id.split(':').collect();
            if parts.len() >= 2 {
                parts[1].parse().map_err(|e| {
                    error!(error = %e, "Invalid message ID");
                    MessengerError::Serialization(format!("Invalid message ID: {}", e))
                })?
            } else {
                error!("Invalid message ID format");
                return Err(MessengerError::Serialization(format!(
                    "Invalid message ID format: {}",
                    message_external_id
                )));
            }
        } else {
            message_external_id.parse().map_err(|e| {
                error!(error = %e, "Invalid message ID");
                MessengerError::Serialization(format!("Invalid message ID: {}", e))
            })?
        };

        let dialog = Self::find_dialog_with_client(&client, chat_external_id).await?;
        let chat = dialog.peer();

        // Delete the message
        let chat_ref = chat.to_ref().ok_or_else(|| {
            error!(chat_id = %chat.id().bare_id(), "Could not get chat reference");
            MessengerError::NotFound(format!(
                "Could not get reference for chat: {}",
                chat.id().bare_id()
            ))
        })?;
        client
            .delete_messages(chat_ref, &[message_id])
            .await
            .map_err(|e| {
                error!(error = %e, "Failed to delete message");
                MessengerError::Connection(format!("Failed to delete message: {}", e))
            })?;

        info!("Message deleted successfully");
        Ok(())
    }
}
