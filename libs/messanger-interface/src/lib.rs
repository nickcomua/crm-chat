//! Universal messenger client interface for CRM chat ingestion.
//!
//! This crate provides platform-agnostic traits and data structures for
//! interacting with various messaging platforms (Telegram, WhatsApp, etc.).

// Re-export all public types and traits
pub mod chat;
pub mod client;
pub mod error;
pub mod media;
pub mod message;
pub mod native;
pub mod types;
pub mod update;

pub use chat::ChatSummary;
pub use client::MessengerClient;
pub use error::MessengerError;
pub use media::{MediaKind, MediaSummary};
pub use message::MessageSummary;
pub use native::NativePayload;
pub use types::{DialogStream, ExternalId, MessageStream, UpdateStream};
pub use update::Update;

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::Value as JsonValue;
    use std::collections::HashMap;
    use tokio::sync::Mutex;
    use tokio_stream::{self as stream, StreamExt};

    // Mock MessengerClient implementation
    struct MockMessengerClient {
        authorized: bool,
        client_external_id: ExternalId,
        chats: HashMap<ExternalId, ChatSummary>,
        messages: Mutex<HashMap<ExternalId, MessageSummary>>,
        media: HashMap<ExternalId, MediaSummary>,
        native_chats: HashMap<ExternalId, JsonValue>,
        native_messages: HashMap<ExternalId, JsonValue>,
        native_media: HashMap<ExternalId, JsonValue>,
        dialogs: Vec<ChatSummary>,
    }

    impl MockMessengerClient {
        fn new() -> Self {
            let mut client = Self {
                authorized: true,
                client_external_id: "test:12345".to_string(),
                chats: HashMap::new(),
                messages: Mutex::new(HashMap::new()),
                media: HashMap::new(),
                native_chats: HashMap::new(),
                native_messages: HashMap::new(),
                native_media: HashMap::new(),
                dialogs: vec![],
            };

            // Add some test data
            let chat1 = ChatSummary {
                external_id: "chat:1".to_string(),
                name: Some("Test Chat 1".to_string()),
                chat_type: Some("user".to_string()),
                is_pinned: true,
            };
            let chat2 = ChatSummary {
                external_id: "chat:2".to_string(),
                name: Some("Test Chat 2".to_string()),
                chat_type: Some("group".to_string()),
                is_pinned: false,
            };

            client
                .chats
                .insert(chat1.external_id.clone(), chat1.clone());
            client
                .chats
                .insert(chat2.external_id.clone(), chat2.clone());
            client.dialogs = vec![chat1.clone(), chat2.clone()];

            client.native_chats.insert(
                chat1.external_id.clone(),
                serde_json::json!({
                    "id": chat1.external_id,
                    "name": chat1.name,
                    "type": chat1.chat_type
                }),
            );

            let media1 = MediaSummary {
                external_id: "media:1".to_string(),
                kind: MediaKind::Photo,
                url: Some("https://example.com/photo.jpg".to_string()),
                metadata: Some(serde_json::json!({"width": 1920, "height": 1080})),
                mime_type: None,
                file_name: None,
                file_size: None,
                width: Some(1920),
                height: Some(1080),
                duration: None,
            };
            client
                .media
                .insert(media1.external_id.clone(), media1.clone());
            client.native_media.insert(
                media1.external_id.clone(),
                serde_json::json!({
                    "id": media1.external_id,
                    "kind": "photo",
                    "url": media1.url
                }),
            );

            let msg1 = MessageSummary {
                external_id: "msg:1".to_string(),
                chat_external_id: chat1.external_id.clone(),
                text: Some("Hello!".to_string()),
                sender_id: "sender:1".to_string(),
                outgoing: false,
                timestamp_ms: Some(1000),
                media_external_id: Some(media1.external_id.clone()),
                media_summary: Some(media1.clone()),
                reply_to_message_id: None,
                reply_to_text: None,
            };

            let mut messages = HashMap::new();
            messages.insert(msg1.external_id.clone(), msg1.clone());

            let mut native_messages = HashMap::new();
            native_messages.insert(
                msg1.external_id.clone(),
                serde_json::json!({
                    "id": msg1.external_id,
                    "text": msg1.text,
                    "outgoing": msg1.outgoing,
                    "media_id": msg1.media_external_id
                }),
            );

            Self {
                authorized: client.authorized,
                client_external_id: client.client_external_id,
                chats: client.chats,
                messages: Mutex::new(messages),
                media: client.media,
                native_chats: client.native_chats,
                native_messages,
                native_media: client.native_media,
                dialogs: client.dialogs,
            }
        }
    }

    #[async_trait]
    impl MessengerClient for MockMessengerClient {
        // async fn login<'callback, F, Fut>(
        //     &self,
        //     _question_callback: F,
        // ) -> Result<(), MessengerError>
        // where
        //     F: Send + Sync + Fn(String) -> Fut + 'callback,
        //     Fut: std::future::Future<Output = Option<String>> + Send + 'callback,
        // {
        //     Ok(())
        // }

        async fn is_authorized(&self) -> Result<bool, MessengerError> {
            Ok(self.authorized)
        }

        async fn get_client_external_id(&self) -> Result<ExternalId, MessengerError> {
            Ok(self.client_external_id.clone())
        }

        async fn iter_dialogs(&self) -> Result<DialogStream, MessengerError> {
            let dialogs = self.dialogs.clone();
            let stream = stream::iter(dialogs.into_iter().map(Ok));
            Ok(Box::pin(stream))
        }

        async fn get_messages_count(
            &self,
            chat_external_id: &ExternalId,
        ) -> Result<usize, MessengerError> {
            let messages = self
                .messages
                .lock()
                .await
                .values()
                .filter(|m| &m.chat_external_id == chat_external_id)
                .count();
            Ok(messages)
        }

        async fn iter_messages(
            &self,
            chat_external_id: &ExternalId,
        ) -> Result<MessageStream, MessengerError> {
            let messages: Vec<MessageSummary> = self
                .messages
                .lock()
                .await
                .values()
                .filter(|m| &m.chat_external_id == chat_external_id)
                .cloned()
                .collect();
            let stream = stream::iter(messages.into_iter().map(Ok));
            Ok(Box::pin(stream))
        }

        async fn iter_updates(&self) -> Result<UpdateStream, MessengerError> {
            let updates = vec![Update::NewMessage(
                self.messages.lock().await.values().next().unwrap().clone(),
            )];
            let stream = stream::iter(updates.into_iter().map(Ok));
            Ok(Box::pin(stream))
        }

        async fn get_native_chat(
            &self,
            chat_external_id: &ExternalId,
        ) -> Result<NativePayload, MessengerError> {
            self.native_chats
                .get(chat_external_id)
                .map(|payload| NativePayload {
                    payload: payload.clone(),
                })
                .ok_or_else(|| {
                    MessengerError::NotFound(format!("Chat not found: {}", chat_external_id))
                })
        }

        async fn get_native_message(
            &self,
            message_external_id: &ExternalId,
        ) -> Result<NativePayload, MessengerError> {
            self.native_messages
                .get(message_external_id)
                .map(|payload| NativePayload {
                    payload: payload.clone(),
                })
                .ok_or_else(|| {
                    MessengerError::NotFound(format!("Message not found: {}", message_external_id))
                })
        }

        async fn get_native_media(
            &self,
            media_external_id: &ExternalId,
        ) -> Result<NativePayload, MessengerError> {
            self.native_media
                .get(media_external_id)
                .map(|payload| NativePayload {
                    payload: payload.clone(),
                })
                .ok_or_else(|| {
                    MessengerError::NotFound(format!("Media not found: {}", media_external_id))
                })
        }

        async fn save_session(&self) -> Result<(), MessengerError> {
            Ok(())
        }

        async fn load_session(&self) -> Result<(), MessengerError> {
            Ok(())
        }

        async fn send_message(
            &self,
            chat_external_id: &ExternalId,
            _text: &str,
        ) -> Result<ExternalId, MessengerError> {
            // Mock implementation - just return a generated message ID
            let message_id = format!(
                "msg:{}:{}",
                chat_external_id,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
            );
            Ok(message_id)
        }

        async fn edit_message(
            &self,
            chat_external_id: &ExternalId,
            message_external_id: &ExternalId,
            new_text: &str,
        ) -> Result<(), MessengerError> {
            // Mock implementation - update the message if it exists
            let mut messages = self.messages.lock().await;
            if let Some(msg) = messages.get_mut(message_external_id) {
                if msg.chat_external_id == *chat_external_id {
                    msg.text = Some(new_text.to_string());
                    Ok(())
                } else {
                    Err(MessengerError::NotFound(
                        "Message not in specified chat".to_string(),
                    ))
                }
            } else {
                Err(MessengerError::NotFound(format!(
                    "Message not found: {}",
                    message_external_id
                )))
            }
        }

        async fn delete_message(
            &self,
            _chat_external_id: &ExternalId,
            message_external_id: &ExternalId,
        ) -> Result<(), MessengerError> {
            // Mock implementation - remove the message
            if self
                .messages
                .lock()
                .await
                .remove(message_external_id)
                .is_some()
            {
                Ok(())
            } else {
                Err(MessengerError::NotFound(format!(
                    "Message not found: {}",
                    message_external_id
                )))
            }
        }
    }

    #[tokio::test]
    async fn test_dialog_stream() {
        let chats = vec![
            ChatSummary {
                external_id: "chat:1".to_string(),
                name: Some("Chat 1".to_string()),
                chat_type: Some("user".to_string()),
                is_pinned: true,
            },
            ChatSummary {
                external_id: "chat:2".to_string(),
                name: Some("Chat 2".to_string()),
                chat_type: Some("group".to_string()),
                is_pinned: false,
            },
        ];

        let mut stream = stream::iter(chats.clone().into_iter().map(Ok::<_, MessengerError>));
        assert_eq!(stream.next().await.unwrap().unwrap(), chats[0]);
        assert_eq!(stream.next().await.unwrap().unwrap(), chats[1]);
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn test_message_stream() {
        let messages = vec![
            MessageSummary {
                external_id: "msg:1".to_string(),
                chat_external_id: "chat:1".to_string(),
                text: Some("Hello".to_string()),
                sender_id: "sender:1".to_string(),
                outgoing: false,
                timestamp_ms: Some(1000),
                media_external_id: None,
                media_summary: None,
                reply_to_message_id: None,
                reply_to_text: None,
            },
            MessageSummary {
                external_id: "msg:2".to_string(),
                chat_external_id: "chat:1".to_string(),
                text: Some("World".to_string()),
                sender_id: "sender:2".to_string(),
                outgoing: true,
                timestamp_ms: Some(2000),
                media_external_id: None,
                media_summary: None,
                reply_to_message_id: None,
                reply_to_text: None,
            },
        ];

        let mut stream = stream::iter(messages.clone().into_iter().map(Ok::<_, MessengerError>));
        assert_eq!(stream.next().await.unwrap().unwrap(), messages[0]);
        assert_eq!(stream.next().await.unwrap().unwrap(), messages[1]);
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn test_messenger_client_basic() {
        let client = MockMessengerClient::new();

        assert!(client.is_authorized().await.unwrap());
        assert_eq!(client.get_client_external_id().await.unwrap(), "test:12345");
    }

    #[tokio::test]
    async fn test_messenger_client_dialogs() {
        let client = MockMessengerClient::new();
        let mut dialogs = client.iter_dialogs().await.unwrap();

        let chat1 = dialogs.next().await.unwrap().unwrap();
        assert_eq!(chat1.external_id, "chat:1");

        let chat2 = dialogs.next().await.unwrap().unwrap();
        assert_eq!(chat2.external_id, "chat:2");

        assert!(dialogs.next().await.is_none());
    }

    #[tokio::test]
    async fn test_messenger_client_messages() {
        let client = MockMessengerClient::new();
        let mut messages = client.iter_messages(&"chat:1".to_string()).await.unwrap();

        let msg = messages.next().await.unwrap().unwrap();
        assert_eq!(msg.external_id, "msg:1");
        assert_eq!(msg.media_external_id, Some("media:1".to_string()));

        assert!(messages.next().await.is_none());
    }

    #[tokio::test]
    async fn test_messenger_client_native_chat() {
        let client = MockMessengerClient::new();

        let native = client.get_native_chat(&"chat:1".to_string()).await.unwrap();
        assert_eq!(native.payload["id"], "chat:1");
        assert_eq!(native.payload["name"], "Test Chat 1");

        let result = client.get_native_chat(&"nonexistent".to_string()).await;
        assert!(result.is_err());
        if let Err(MessengerError::NotFound(_)) = result {
            // Expected
        } else {
            panic!("Expected NotFound error");
        }
    }

    #[tokio::test]
    async fn test_messenger_client_native_message() {
        let client = MockMessengerClient::new();

        let native = client
            .get_native_message(&"msg:1".to_string())
            .await
            .unwrap();
        assert_eq!(native.payload["id"], "msg:1");
        assert_eq!(native.payload["text"], "Hello!");

        let result = client.get_native_message(&"nonexistent".to_string()).await;
        assert!(result.is_err());
        if let Err(MessengerError::NotFound(_)) = result {
            // Expected
        } else {
            panic!("Expected NotFound error");
        }
    }

    #[tokio::test]
    async fn test_messenger_client_native_media() {
        let client = MockMessengerClient::new();

        let native = client
            .get_native_media(&"media:1".to_string())
            .await
            .unwrap();
        assert_eq!(native.payload["id"], "media:1");
        assert_eq!(native.payload["kind"], "photo");

        let result = client.get_native_media(&"nonexistent".to_string()).await;
        assert!(result.is_err());
        if let Err(MessengerError::NotFound(_)) = result {
            // Expected
        } else {
            panic!("Expected NotFound error");
        }
    }

    #[tokio::test]
    async fn test_messenger_client_updates() {
        let client = MockMessengerClient::new();
        let mut updates = client.iter_updates().await.unwrap();

        let update = updates.next().await.unwrap().unwrap();
        match update {
            Update::NewMessage(msg) => {
                assert_eq!(msg.external_id, "msg:1");
            }
            _ => panic!("Expected NewMessage update"),
        }
    }

    #[tokio::test]
    async fn test_update_serialization() {
        let update = Update::NewMessage(MessageSummary {
            external_id: "msg:1".to_string(),
            chat_external_id: "chat:1".to_string(),
            text: Some("Test".to_string()),
            sender_id: "sender:1".to_string(),
            outgoing: false,
            timestamp_ms: Some(1000),
            media_external_id: None,
            media_summary: None,
            reply_to_message_id: None,
            reply_to_text: None,
        });

        let json = serde_json::to_string(&update).unwrap();
        let deserialized: Update = serde_json::from_str(&json).unwrap();

        match (update, deserialized) {
            (Update::NewMessage(m1), Update::NewMessage(m2)) => {
                assert_eq!(m1.external_id, m2.external_id);
                assert_eq!(m1.text, m2.text);
            }
            _ => panic!("Mismatch"),
        }
    }

    #[tokio::test]
    async fn test_chat_summary_serialization() {
        let chat = ChatSummary {
            external_id: "chat:1".to_string(),
            name: Some("Test Chat".to_string()),
            chat_type: Some("user".to_string()),
            is_pinned: true,
        };

        let json = serde_json::to_string(&chat).unwrap();
        let deserialized: ChatSummary = serde_json::from_str(&json).unwrap();

        assert_eq!(chat, deserialized);
    }

    #[tokio::test]
    async fn test_message_summary_serialization() {
        let msg = MessageSummary {
            external_id: "msg:1".to_string(),
            chat_external_id: "chat:1".to_string(),
            sender_id: "sender:1".to_string(),
            text: Some("Hello".to_string()),
            outgoing: false,
            timestamp_ms: Some(1000),
            media_external_id: Some("media:1".to_string()),
            media_summary: None,
            reply_to_message_id: None,
            reply_to_text: None,
        };

        let json = serde_json::to_string(&msg).unwrap();
        let deserialized: MessageSummary = serde_json::from_str(&json).unwrap();

        assert_eq!(msg, deserialized);
    }

    #[tokio::test]
    async fn test_media_summary_serialization() {
        let media = MediaSummary {
            external_id: "media:1".to_string(),
            kind: MediaKind::Photo,
            url: Some("https://example.com/photo.jpg".to_string()),
            metadata: Some(serde_json::json!({"width": 1920, "height": 1080})),
            mime_type: Some("image/jpeg".to_string()),
            file_name: None,
            file_size: Some(102400),
            width: Some(1920),
            height: Some(1080),
            duration: None,
        };

        let json = serde_json::to_string(&media).unwrap();
        let deserialized: MediaSummary = serde_json::from_str(&json).unwrap();

        assert_eq!(media, deserialized);
    }

    #[tokio::test]
    async fn test_media_kind_serialization() {
        let kinds = vec![
            MediaKind::Photo,
            MediaKind::Video,
            MediaKind::VideoNote,
            MediaKind::Audio,
            MediaKind::Voice,
            MediaKind::Sticker,
            MediaKind::Animation,
            MediaKind::Document,
        ];

        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            let deserialized: MediaKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, deserialized);
        }
    }
}
