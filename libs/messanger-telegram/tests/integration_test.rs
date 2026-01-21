//! Integration tests for the Telegram messenger client implementation.
//!
//! These tests require valid Telegram API credentials and will make actual
//! API calls to Telegram. Set up your test configuration before running these tests.

use messanger_interface::{
    session::JsonSessionStore, AuthConfig, MessengerClient, MessengerClientBuilder, SessionStore,
    Update,
};
use messanger_telegram::TelegramClientBuilder;
use serde_json::json;
use serial_test::serial;
use std::time::Duration;
use tokio_stream::StreamExt;

/// Default timeout for most tests (60 seconds)
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// Extended timeout for tests involving multiple operations (120 seconds)
const EXTENDED_TIMEOUT: Duration = Duration::from_secs(120);

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
        let api_id_1 = std::env::var("TG_API_ID_1").ok()?.parse().ok()?;
        let api_hash_1 = std::env::var("TG_API_HASH_1").ok()?;
        let session_file_1 = std::env::var("TG_SESSION_FILE_1").ok()?;
        let api_id_2 = std::env::var("TG_API_ID_2").ok()?.parse().ok()?;
        let api_hash_2 = std::env::var("TG_API_HASH_2").ok()?;
        let session_file_2 = std::env::var("TG_SESSION_FILE_2").ok()?;
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

    fn to_session_config(&self) -> Option<Box<dyn SessionStore>> {
        Some(Box::new(JsonSessionStore::new(json!({
            "session_file": &self.session_file
        }))))
    }
}

#[tokio::test]
#[serial]
async fn test_client_creation() {
    tokio::time::timeout(DEFAULT_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client1 = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");

        // Create second client
        let client2 = builder
            .build(config2.to_auth_config(), config2.to_session_config())
            .await
            .expect("Failed to create second client");

        // Test that clients are created
        assert!(client1.is_authorized().await.is_ok());
        assert!(client2.is_authorized().await.is_ok());
    })
    .await
    .expect("Test timed out");
}

#[tokio::test]
#[serial]
async fn test_client_external_ids() {
    tokio::time::timeout(DEFAULT_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client1 = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");

        // Create second client
        let client2 = builder
            .build(config2.to_auth_config(), config2.to_session_config())
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
        println!("Client 1 external ID: {}", id1);
        println!("Client 2 external ID: {}", id2);
        // They should be different (assuming different accounts)
        assert_ne!(
            id1, id2,
            "Both clients have the same external ID - they should be different accounts"
        );
    })
    .await
    .expect("Test timed out");
}

#[tokio::test]
#[serial]
async fn test_iter_dialogs() {
    tokio::time::timeout(DEFAULT_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, _config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");

        // Check authorization first
        let is_authorized = client
            .is_authorized()
            .await
            .expect("Failed to check authorization");

        if !is_authorized {
            panic!("Client is not authorized");
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

        // Note: We don't assert dialog_count > 0 because some test accounts
        // may legitimately have no dialogs. The test validates that iteration
        // completes without errors, regardless of dialog count.
        if dialog_count == 0 {
            println!(
                "Warning: No dialogs found for this account (this is valid for new/empty accounts)"
            );
        }

        println!("Found {} dialogs", dialog_count);
    })
    .await
    .expect("Test timed out");
}

#[tokio::test]
#[serial]
async fn test_iter_messages() {
    tokio::time::timeout(DEFAULT_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, _config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");

        // Check authorization
        let is_authorized = client
            .is_authorized()
            .await
            .expect("Failed to check authorization");

        if !is_authorized {
            panic!("Client is not authorized");
        }

        // Get first dialog to test messages
        let mut dialogs = client
            .iter_dialogs()
            .await
            .expect("Failed to get dialogs stream");

        let first_dialog = match dialogs.next().await {
            Some(Ok(dialog)) => dialog,
            Some(Err(e)) => {
                panic!("Failed to get first dialog: {}", e);
            }
            None => {
                panic!("No dialogs found");
            }
        };

        println!("First dialog: {:?}", first_dialog);
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
    })
    .await
    .expect("Test timed out");
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
#[serial]
async fn test_native_chat_access() {
    tokio::time::timeout(DEFAULT_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, _config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");
        // Check authorization
        let is_authorized = client
            .is_authorized()
            .await
            .expect("Failed to check authorization");

        if !is_authorized {
            panic!("Client is not authorized");
        }

        // Get first dialog
        let mut dialogs = client
            .iter_dialogs()
            .await
            .expect("Failed to get dialogs stream");

        let first_dialog = match dialogs.next().await {
            Some(Ok(dialog)) => dialog,
            Some(Err(e)) => {
                panic!("Failed to get first dialog: {}", e);
            }
            None => {
                panic!("No dialogs found");
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
    })
    .await
    .expect("Test timed out");
}

#[tokio::test]
#[serial]
async fn test_native_message_access() {
    tokio::time::timeout(DEFAULT_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, _config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");

        // Check authorization
        let is_authorized = client
            .is_authorized()
            .await
            .expect("Failed to check authorization");

        if !is_authorized {
            panic!("Client is not authorized");
        }
        println!("Client is authorized");
        // Get first dialog
        let first_dialog = {
            let mut dialogs = client
                .iter_dialogs()
                .await
                .expect("Failed to get dialogs stream");

            match dialogs.next().await {
                Some(Ok(dialog)) => dialog,
                Some(Err(e)) => {
                    panic!("Failed to get first dialog: {}", e);
                }
                None => {
                    panic!("No dialogs found");
                }
            }
        };
        dbg!("First dialog: {}", &first_dialog);
        // Drop dialogs stream to release the mutex lock held by the spawned task
        // drop(dialogs);

        // Get first message
        let first_message = {
            let mut messages = client
                .iter_messages(&first_dialog.external_id)
                .await
                .expect("Failed to get messages stream");

            match messages.next().await {
                Some(Ok(message)) => message,
                Some(Err(e)) => {
                    panic!("Failed to get first message: {}", e);
                }
                None => {
                    panic!("No messages found in dialog");
                }
            }
        };
        dbg!("First message: {}", &first_message);

        // Get native message payload
        // Note: message external_id format is "message_id" in our implementation
        // We need to construct it properly: "chat_id:message_id"
        let message_external_id =
            format!("{}:{}", first_dialog.external_id, first_message.external_id);
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
    })
    .await
    .expect("Test timed out");
}

#[tokio::test]
#[serial]
async fn test_send_edit_delete_messages_with_update_stream() {
    tokio::time::timeout(EXTENDED_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client1 = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");

        // Create second client
        let client2 = builder
            .build(config2.to_auth_config(), config2.to_session_config())
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
            panic!("One or both clients are not authorized");
        }

        // Get client2's user ID to find the correct dialog
        let client2_native = client2.get_native_client().await;
        let client2_lock = client2_native.lock().await;
        let client2_me = client2_lock.get_me().await.expect("Failed to get client2 user info");
        let client2_user_id = client2_me.raw.id().to_string();
        drop(client2_lock);
        println!("Client2 user ID: {}", client2_user_id);

        // Find the dialog between client1 and client2 using client2's user ID
        let mut dialogs = client1
            .iter_dialogs()
            .await
            .expect("Failed to get dialogs stream");

        let mut target_chat_id: Option<String> = None;
        while let Some(dialog_result) = dialogs.next().await {
            let dialog = dialog_result.expect("Failed to get dialog");

            // Check if this is a user dialog matching client2's user ID
            if dialog.chat_type.as_deref() == Some("user") && dialog.external_id == client2_user_id {
                println!("Found dialog with client2: {:?}", dialog);
                target_chat_id = Some(dialog.external_id.clone());
                break;
            }
        }

        let chat_external_id = target_chat_id.unwrap_or_else(|| {
            panic!("No dialog found between client1 and client2. Please ensure client1 has a dialog with client2 (user ID: {}).", client2_user_id);
        });

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
    })
    .await
    .expect("Test timed out");
}

#[tokio::test]
#[serial]
async fn test_get_messages_count() {
    tokio::time::timeout(DEFAULT_TIMEOUT, async {
        let configs = TestConfig::from_env();

        if configs.is_none() {
            println!("Skipping test: Environment variables not set");
            return;
        }

        let (config1, _config2) = configs.unwrap();
        let builder = TelegramClientBuilder::new();

        // Create first client
        let client = builder
            .build(config1.to_auth_config(), config1.to_session_config())
            .await
            .expect("Failed to create first client");

        // Check authorization
        let is_authorized = client
            .is_authorized()
            .await
            .expect("Failed to check authorization");

        if !is_authorized {
            panic!("Client is not authorized");
        }

        // Get the user's own ID to find Saved Messages chat
        let native_client = client.get_native_client().await;
        let client_lock = native_client.lock().await;
        let me = client_lock.get_me().await.expect("Failed to get user info");
        let user_id = me.raw.id();
        drop(client_lock);

        // Find Saved Messages chat (chat where chat ID equals user ID)
        let mut dialogs = client
            .iter_dialogs()
            .await
            .expect("Failed to get dialogs stream");

        let saved_messages_chat_id = loop {
            match dialogs.next().await {
                Some(Ok(dialog)) => {
                    // Check if this is the Saved Messages chat (chat ID matches user ID)
                    if dialog.external_id == user_id.to_string() {
                        break dialog.external_id;
                    }
                }
                Some(Err(e)) => {
                    panic!("Failed to get dialog: {}", e);
                }
                None => {
                    panic!("Saved Messages chat not found. User ID: {}", user_id);
                }
            }
        };

        println!("Found Saved Messages chat: {}", saved_messages_chat_id);

        // Get initial message count
        let initial_count = client
            .get_messages_count(&saved_messages_chat_id)
            .await
            .expect("Failed to get initial message count");

        println!("Initial message count: {}", initial_count);

        // Send a message to Saved Messages
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let test_message = format!("Test message for count {}", timestamp);
        let _message_external_id = client
            .send_message(&saved_messages_chat_id, &test_message)
            .await
            .expect("Failed to send message");

        println!("Sent test message: {}", test_message);

        // Wait a bit for the message to be processed
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        // Get message count again
        let new_count = client
            .get_messages_count(&saved_messages_chat_id)
            .await
            .expect("Failed to get new message count");

        println!("New message count: {}", new_count);

        // Verify the count increased by 1
        let delta = new_count.saturating_sub(initial_count);
        println!(
            "Saved Messages count delta after sending one test message: {} (initial={}, new={})",
            delta, initial_count, new_count
        );
        assert!(
            new_count > initial_count,
            "Expected Saved Messages count to increase by at least 1 after sending a test message"
        );

        println!("✓ Message count test passed!");
    })
    .await
    .expect("Test timed out");
}
