//! Integration tests for the Telegram messenger client implementation.
//!
//! These tests require valid Telegram API credentials and will make actual
//! API calls to Telegram. Set up your test configuration before running these tests.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use messanger_inteface::{AuthConfig, MessengerClient, MessengerClientBuilder, Update};
use messanger_telegram::TelegramClientBuilder;
use serde_json::json;
use std::path::PathBuf;
use tokio_stream::StreamExt;

/// Test configuration for Telegram clients.
/// This should be populated with actual credentials from environment variables
/// or a config file.
struct TestConfig {
    api_id: u64,
    api_hash: String,
    session_file: String,
}

impl TestConfig {
    /// Load test configuration from environment variables.
    ///
    /// Expected environment variables:
    /// - TG_API_ID_1: API ID for first client
    /// - TG_API_HASH_1: API hash for first client
    /// - TG_SESSION_FILE_1: Session file for first client
    /// - TG_API_ID_2: API ID for second client
    /// - TG_API_HASH_2: API hash for second client
    /// - TG_SESSION_FILE_2: Session file for second client
    fn from_env() -> Option<(TestConfig, TestConfig)> {
        let api_id_1 = env!("TG_API_ID_1").parse().ok()?;
        let api_hash_1 = env!("TG_API_HASH_1").to_string();
        let session_file_1 = env!("TG_SESSION_FILE_1").to_string();
        let api_id_2 = env!("TG_API_ID_2").parse().ok()?;
        let api_hash_2 = env!("TG_API_HASH_2").to_string();
        let session_file_2 = env!("TG_SESSION_FILE_2").to_string();
        Some((
            TestConfig {
                api_id: api_id_1,
                api_hash: api_hash_1,
                session_file: session_file_1,
            },
            TestConfig {
                api_id: api_id_2,
                api_hash: api_hash_2,
                session_file: session_file_2,
            },
        ))
    }

    fn to_auth_config(&self) -> AuthConfig {
        AuthConfig {
            credentials: json!({
                "api_id": self.api_id,
                "api_hash": self.api_hash,
            }),
        }
    }
}

/// File-based session store for testing.
#[derive(Clone)]
struct TestSessionStore {
    session_file: PathBuf,
}

impl TestSessionStore {
    fn new(session_file: impl Into<PathBuf>) -> Self {
        Self {
            session_file: session_file.into(),
        }
    }
}

#[async_trait::async_trait]
impl messanger_inteface::SessionStore for TestSessionStore {
    async fn load(&self) -> Result<Option<serde_json::Value>, messanger_inteface::MessengerError> {
        if !self.session_file.exists() {
            return Ok(None);
        }

        // Read binary session file
        let bytes = tokio::fs::read(&self.session_file).await.map_err(|e| {
            messanger_inteface::MessengerError::Other(format!("Failed to read session file: {}", e))
        })?;

        // Base64 encode and wrap in JSON with session_data field
        let session_json = json!({
            "session_data": STANDARD.encode(&bytes)
        });

        Ok(Some(session_json))
    }

    async fn save(&self, _: &serde_json::Value) -> Result<(), messanger_inteface::MessengerError> {
        Ok(())
    }

    async fn delete(&self) -> Result<(), messanger_inteface::MessengerError> {
        Ok(())
    }
}

#[tokio::test]
async fn test_client_creation() {
    let configs = TestConfig::from_env();
    if configs.is_none() {
        eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
        return;
    }

    let (config1, config2) = configs.unwrap();
    let builder = TelegramClientBuilder::new();

    // Create first client
    let session_store1 = Box::new(TestSessionStore::new(&config1.session_file));
    let client1 = builder
        .build(config1.to_auth_config(), Some(session_store1))
        .await
        .expect("Failed to create first client");

    // Create second client
    let session_store2 = Box::new(TestSessionStore::new(&config2.session_file));
    let client2 = builder
        .build(config2.to_auth_config(), Some(session_store2))
        .await
        .expect("Failed to create second client");

    // Test that clients are created
    assert!(client1.is_authorized().await.is_ok());
    assert!(client2.is_authorized().await.is_ok());
}

#[tokio::test]
async fn test_client_external_ids() {
    let configs = TestConfig::from_env();
    if configs.is_none() {
        eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
        return;
    }

    let (config1, config2) = configs.unwrap();
    let builder = TelegramClientBuilder::new();

    let session_store1 = Box::new(TestSessionStore::new(&config1.session_file));
    let client1 = builder
        .build(config1.to_auth_config(), Some(session_store1))
        .await
        .expect("Failed to create first client");

    let session_store2 = Box::new(TestSessionStore::new(&config2.session_file));
    let client2 = builder
        .build(config2.to_auth_config(), Some(session_store2))
        .await
        .expect("Failed to create second client");

    // Get external IDs (should be different for different accounts)
    let id1 = client1
        .get_client_external_id()
        .await
        .expect("Failed to get client1 external ID");
    let id2 = client2
        .get_client_external_id()
        .await
        .expect("Failed to get client2 external ID");

    // Both should start with "telegram:"
    assert!(id1.starts_with("telegram:"));
    assert!(id2.starts_with("telegram:"));

    // They should be different (assuming different accounts)
    assert_ne!(
        id1, id2,
        "Both clients have the same external ID - they should be different accounts"
    );
}

#[tokio::test]
async fn test_iter_dialogs() {
    let configs = TestConfig::from_env();
    if configs.is_none() {
        eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
        return;
    }

    let (config1, _config2) = configs.unwrap();
    let builder = TelegramClientBuilder::new();

    let session_store = Box::new(TestSessionStore::new(&config1.session_file));
    let client = builder
        .build(config1.to_auth_config(), Some(session_store))
        .await
        .expect("Failed to create client");

    // Check authorization first
    let is_authorized = client
        .is_authorized()
        .await
        .expect("Failed to check authorization");

    if !is_authorized {
        eprintln!("Skipping test: Client is not authorized");
        return;
    }

    // Iterate dialogs
    let mut dialogs = client
        .iter_dialogs()
        .await
        .expect("Failed to get dialogs stream");

    let mut dialog_count = 0;
    while let Some(dialog_result) = dialogs.next().await {
        let dialog = dialog_result.expect("Failed to get dialog");

        // Verify dialog structure
        assert!(!dialog.external_id.is_empty());
        assert!(dialog.chat_type.is_some());

        dialog_count += 1;

        // Limit to first 10 dialogs for testing
        if dialog_count >= 10 {
            break;
        }
    }

    println!("Found {} dialogs", dialog_count);
}

#[tokio::test]
async fn test_iter_messages() {
    let configs = TestConfig::from_env();
    if configs.is_none() {
        eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
        return;
    }

    let (config1, _config2) = configs.unwrap();
    let builder = TelegramClientBuilder::new();

    let session_store = Box::new(TestSessionStore::new(&config1.session_file));
    let client = builder
        .build(config1.to_auth_config(), Some(session_store))
        .await
        .expect("Failed to create client");

    // Check authorization
    let is_authorized = client
        .is_authorized()
        .await
        .expect("Failed to check authorization");

    if !is_authorized {
        eprintln!("Skipping test: Client is not authorized");
        return;
    }

    // Get first dialog to test messages
    let mut dialogs = client
        .iter_dialogs()
        .await
        .expect("Failed to get dialogs stream");

    let first_dialog = match dialogs.next().await {
        Some(Ok(dialog)) => dialog,
        Some(Err(e)) => {
            eprintln!("Failed to get first dialog: {}", e);
            return;
        }
        None => {
            eprintln!("No dialogs found");
            return;
        }
    };

    // Get messages for the first dialog
    let mut messages = client
        .iter_messages(&first_dialog.external_id)
        .await
        .expect("Failed to get messages stream");

    let mut message_count = 0;
    while let Some(message_result) = messages.next().await {
        let message = message_result.expect("Failed to get message");

        // Verify message structure
        assert!(!message.external_id.is_empty());
        assert_eq!(message.chat_external_id, first_dialog.external_id);

        message_count += 1;

        // Limit to first 10 messages for testing
        if message_count >= 10 {
            break;
        }
    }

    println!(
        "Found {} messages in dialog {}",
        message_count, first_dialog.external_id
    );
}

// #[tokio::test]
// async fn test_session_persistence() {
//     let configs = TestConfig::from_env();
//     if configs.is_none() {
//         eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
//         return;
//     }

//     let (config1, _config2) = configs.unwrap();
//     let builder = TelegramClientBuilder::new();

//     // Create client with session store
//     let session_store = Box::new(TestSessionStore::new(&config1.session_file));

//     let client = builder
//         .build(config1.to_auth_config(), Some(session_store))
//         .await
//         .expect("Failed to create client");

//     // Save session
//     client.save_session().await.expect("Failed to save session");

//     // Verify session was saved by checking the file
//     assert!(
//         std::path::Path::new(&config1.session_file).exists(),
//         "Session file should exist after saving"
//     );

//     println!("Session saved successfully");
// }

#[tokio::test]
async fn test_native_chat_access() {
    let configs = TestConfig::from_env();
    if configs.is_none() {
        eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
        return;
    }

    let (config1, _config2) = configs.unwrap();
    let builder = TelegramClientBuilder::new();

    let session_store = Box::new(TestSessionStore::new(&config1.session_file));
    let client = builder
        .build(config1.to_auth_config(), Some(session_store))
        .await
        .expect("Failed to create client");

    // Check authorization
    let is_authorized = client
        .is_authorized()
        .await
        .expect("Failed to check authorization");

    if !is_authorized {
        eprintln!("Skipping test: Client is not authorized");
        return;
    }

    // Get first dialog
    let mut dialogs = client
        .iter_dialogs()
        .await
        .expect("Failed to get dialogs stream");

    let first_dialog = match dialogs.next().await {
        Some(Ok(dialog)) => dialog,
        Some(Err(e)) => {
            eprintln!("Failed to get first dialog: {}", e);
            return;
        }
        None => {
            eprintln!("No dialogs found");
            return;
        }
    };

    // Get native chat payload
    let native_chat = client
        .get_native_chat(&first_dialog.external_id)
        .await
        .expect("Failed to get native chat");

    // Verify native payload structure
    assert!(
        native_chat.payload.is_object(),
        "Native chat payload should be a JSON object"
    );
    println!("Native chat payload: {}", native_chat.payload);
}

#[tokio::test]
async fn test_native_message_access() {
    let configs = TestConfig::from_env();
    if configs.is_none() {
        eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
        return;
    }

    let (config1, _config2) = configs.unwrap();
    let builder = TelegramClientBuilder::new();

    let session_store = Box::new(TestSessionStore::new(&config1.session_file));
    let client = builder
        .build(config1.to_auth_config(), Some(session_store))
        .await
        .expect("Failed to create client");

    // Check authorization
    let is_authorized = client
        .is_authorized()
        .await
        .expect("Failed to check authorization");

    if !is_authorized {
        eprintln!("Skipping test: Client is not authorized");
        return;
    }

    // Get first dialog
    let mut dialogs = client
        .iter_dialogs()
        .await
        .expect("Failed to get dialogs stream");

    let first_dialog = match dialogs.next().await {
        Some(Ok(dialog)) => dialog,
        Some(Err(e)) => {
            eprintln!("Failed to get first dialog: {}", e);
            return;
        }
        None => {
            eprintln!("No dialogs found");
            return;
        }
    };

    // Get first message
    let mut messages = client
        .iter_messages(&first_dialog.external_id)
        .await
        .expect("Failed to get messages stream");

    let first_message = match messages.next().await {
        Some(Ok(message)) => message,
        Some(Err(e)) => {
            eprintln!("Failed to get first message: {}", e);
            return;
        }
        None => {
            eprintln!("No messages found in dialog");
            return;
        }
    };

    // Get native message payload
    // Note: message external_id format is "message_id" in our implementation
    // We need to construct it properly: "chat_id:message_id"
    let message_external_id = format!("{}:{}", first_dialog.external_id, first_message.external_id);
    let native_message = client
        .get_native_message(&message_external_id)
        .await
        .expect("Failed to get native message");

    // Verify native payload structure
    assert!(
        native_message.payload.is_object(),
        "Native message payload should be a JSON object"
    );
    println!("Native message payload: {}", native_message.payload);
}

#[tokio::test]
async fn test_send_edit_delete_messages_with_update_stream() {
    let configs = TestConfig::from_env();
    if configs.is_none() {
        eprintln!("Skipping test: TG_API_ID_1, TG_API_HASH_1, TG_API_ID_2, TG_API_HASH_2 not set");
        return;
    }

    let (config1, config2) = configs.unwrap();
    let builder = TelegramClientBuilder::new();

    // Create first client (sender)
    let session_store1 = Box::new(TestSessionStore::new(&config1.session_file));
    let client1 = builder
        .build(config1.to_auth_config(), Some(session_store1))
        .await
        .expect("Failed to create first client");

    // Create second client (receiver)
    let session_store2 = Box::new(TestSessionStore::new(&config2.session_file));
    let client2 = builder
        .build(config2.to_auth_config(), Some(session_store2))
        .await
        .expect("Failed to create second client");

    // Check authorization
    let is_authorized1 = client1
        .is_authorized()
        .await
        .expect("Failed to check authorization for client1");
    let is_authorized2 = client2
        .is_authorized()
        .await
        .expect("Failed to check authorization for client2");

    if !is_authorized1 || !is_authorized2 {
        eprintln!("Skipping test: One or both clients are not authorized");
        return;
    }

    // Find the dialog between client1 and client2
    // We need to find a user dialog (we'll use the first user dialog found)
    let mut dialogs = client1
        .iter_dialogs()
        .await
        .expect("Failed to get dialogs stream");

    let mut target_chat_id: Option<String> = None;
    while let Some(dialog_result) = dialogs.next().await {
        let dialog = dialog_result.expect("Failed to get dialog");

        // Check if this is a user dialog (not a group/channel)
        if dialog.chat_type.as_deref() == Some("user") {
            // Try to get the native chat to check if it matches client2
            // For now, we'll use the first user dialog or we could check phone numbers
            // For simplicity, let's use the first user dialog we find
            target_chat_id = Some(dialog.external_id.clone());
            break;
        }
    }

    let chat_external_id = target_chat_id.unwrap_or_else(|| {
        eprintln!("No user dialog found between clients. Please ensure client1 has a dialog with client2.");
        return String::new();
    });

    if chat_external_id.is_empty() {
        return;
    }

    // Start update stream on client2
    let mut updates = client2
        .iter_updates()
        .await
        .expect("Failed to get update stream");

    // Send initial message from client1
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let initial_text = format!("Test message {}", timestamp);
    let message_external_id = client1
        .send_message(&chat_external_id, &initial_text)
        .await
        .expect("Failed to send message");

    println!("Sent message with external_id: {}", message_external_id);

    // Wait for NewMessage update on client2, filtering out other updates
    // Note: client2 receives the message from client1, so it should be incoming (outgoing=false)
    // Note: chat_id may differ between client1 and client2 perspectives, so we match by text and incoming status
    let new_msg = loop {
        tokio::select! {
            update_result = updates.next() => {
                match update_result {
                    Some(Ok(Update::NewMessage(msg))) => {
                        // Match by text and incoming status (chat_id may differ between client perspectives)
                        if msg.text == Some(initial_text.clone())
                            && !msg.outgoing  // Message should be incoming for client2
                        {
                            println!("✓ Received NewMessage update: chat_id={}, message_id={}",
                                msg.chat_external_id, msg.external_id);
                            break msg;
                        }
                        println!("Skipping NewMessage: chat_id={}, text={:?}, outgoing={}, expected_text={:?}",
                            msg.chat_external_id, msg.text, msg.outgoing, initial_text);
                    }
                    Some(Ok(other)) => {
                        println!("Skipping update: {:?}", other);
                    }
                    Some(Err(e)) => {
                        panic!("Error receiving update: {}", e);
                    }
                    None => {
                        panic!("Update stream ended unexpectedly");
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(10)) => {
                panic!("Timeout waiting for NewMessage update");
            }
        }
    };
    assert_eq!(new_msg.text, Some(initial_text.clone()));
    assert!(!new_msg.outgoing, "Message should be incoming for client2");

    // Use the chat_id and message_id from client2's perspective for subsequent operations on client2
    let client2_chat_id = new_msg.chat_external_id.clone();
    let client2_message_id = new_msg.external_id.clone(); // Use message ID from client2's perspective

    // Note: message IDs can differ between client perspectives
    // For client1 operations, we use client1's message_external_id
    // For client2 update matching, we use client2's message_id

    // Edit the message from client1 (using client1's message_external_id)
    let edited_text = format!("Edited message {}", timestamp);
    client1
        .edit_message(&chat_external_id, &message_external_id, &edited_text)
        .await
        .expect("Failed to edit message");

    println!("Edited message to: {}", edited_text);

    // Wait for MessageEdited update on client2, filtering out other updates
    // Use client2's chat_id and message_id for matching
    let edited_msg = loop {
        tokio::select! {
            update_result = updates.next() => {
                match update_result {
                    Some(Ok(Update::MessageEdited(msg))) => {
                        if msg.chat_external_id == client2_chat_id && msg.external_id == client2_message_id {
                            break msg;
                        }
                        println!("Skipping MessageEdited: chat_id={}, message_id={}, expected_chat_id={}, expected_message_id={}",
                            msg.chat_external_id, msg.external_id, client2_chat_id, client2_message_id);
                    }
                    Some(Ok(other)) => {
                        println!("Skipping update: {:?}", other);
                    }
                    Some(Err(e)) => {
                        panic!("Error receiving update: {}", e);
                    }
                    None => {
                        panic!("Update stream ended unexpectedly");
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(10)) => {
                panic!("Timeout waiting for MessageEdited update");
            }
        }
    };
    assert_eq!(edited_msg.chat_external_id, client2_chat_id);
    assert_eq!(edited_msg.external_id, client2_message_id);
    assert_eq!(edited_msg.text, Some(edited_text.clone()));
    println!(
        "✓ Received MessageEdited update: {}",
        edited_msg.external_id
    );

    // Delete the message from client1
    client1
        .delete_message(&chat_external_id, &message_external_id)
        .await
        .expect("Failed to delete message");

    println!("Deleted message");

    // Wait for MessageDeleted update on client2, filtering out other updates
    // Use client2's message_id for matching (chat_id may be "unknown" in the implementation)
    let deleted_id = loop {
        tokio::select! {
            update_result = updates.next() => {
                match update_result {
                    Some(Ok(Update::MessageDeleted {
                        message_external_ids: deleted_ids,
                        chat_external_id: deleted_chat_id,
                        ..
                    })) => {
                        if deleted_ids.contains(&client2_message_id) {
                            break client2_message_id.clone();
                        }
                        println!("Skipping MessageDeleted: chat_id={:?}, deleted_ids={:?}, expected_message_id={}",
                            deleted_chat_id, deleted_ids, client2_message_id);
                    }
                    Some(Ok(other)) => {
                        println!("Skipping update: {:?}", other);
                    }
                    Some(Err(e)) => {
                        panic!("Error receiving update: {}", e);
                    }
                    None => {
                        panic!("Update stream ended unexpectedly");
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(10)) => {
                panic!("Timeout waiting for MessageDeleted update");
            }
        }
    };
    assert_eq!(
        deleted_id, client2_message_id,
        "Expected deleted message ID to match"
    );
    println!("✓ Received MessageDeleted update: {}", deleted_id);

    println!("All updates received successfully!");
}
