//! Messenger client traits and interfaces.

use async_trait::async_trait;

use crate::error::MessengerError;
use crate::native::NativePayload;
use crate::session::SessionStore;
use crate::types::{AuthConfig, DialogStream, ExternalId, MessageStream, UpdateStream};

/// Main trait for messenger client implementations.
///
/// This trait provides a universal interface for interacting with
/// various messaging platforms while maintaining access to platform-specific
/// native data structures.
#[async_trait]
pub trait MessengerClient: Send + Sync {
    /// Check if the client is currently authorized.
    async fn is_authorized(&self) -> Result<bool, MessengerError>;

    async fn login<'callback, F, Fut>(
        &self,
        question_callback: F,
    ) -> Result<(), MessengerError>
    where
        F: Send + Sync + Fn(String) -> Fut + 'callback,
        Fut: std::future::Future<Output = Option<String>> + Send + 'callback;

    /// Get the external identifier for the authenticated user/account.
    ///
    /// This should return a platform-specific identifier (e.g., phone number,
    /// username, user ID) that can be used to construct client IDs.
    async fn get_client_external_id(&self) -> Result<ExternalId, MessengerError>;

    /// Get a stream of all dialogs/chats.
    async fn iter_dialogs(&self) -> Result<DialogStream, MessengerError>;
    
    /// Get the number of messages in a chat.
    async fn get_messages_count(&self, chat_external_id: &ExternalId) -> Result<usize, MessengerError>;

    /// Get a stream of messages for a specific chat.
    async fn iter_messages(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<MessageStream, MessengerError>;

    /// Get a stream of updates (new messages, deletions, etc.).
    async fn iter_updates(&self) -> Result<UpdateStream, MessengerError>;

    /// Get the native payload for a chat by its external ID.
    ///
    /// This returns the platform-specific raw representation of the chat
    /// as a serialized JSON value.
    async fn get_native_chat(
        &self,
        chat_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError>;

    /// Get the native payload for a message by its external ID.
    ///
    /// This returns the platform-specific raw representation of the message
    /// as a serialized JSON value.
    async fn get_native_message(
        &self,
        message_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError>;

    /// Get the native payload for media by its external ID.
    ///
    /// This returns the platform-specific raw representation of the media
    /// as a serialized JSON value.
    async fn get_native_media(
        &self,
        media_external_id: &ExternalId,
    ) -> Result<NativePayload, MessengerError>;

    /// Save the current session state.
    async fn save_session(&self) -> Result<(), MessengerError>;

    /// Load and restore session state.
    async fn load_session(&self) -> Result<(), MessengerError>;

    /// Send a message to a chat.
    ///
    /// Returns the external identifier of the sent message.
    async fn send_message(
        &self,
        chat_external_id: &ExternalId,
        text: &str,
    ) -> Result<ExternalId, MessengerError>;

    /// Edit an existing message.
    ///
    /// Updates the text content of a message identified by its external ID.
    async fn edit_message(
        &self,
        chat_external_id: &ExternalId,
        message_external_id: &ExternalId,
        new_text: &str,
    ) -> Result<(), MessengerError>;

    /// Delete a message.
    ///
    /// Removes a message from a chat. The message is identified by its external ID.
    async fn delete_message(
        &self,
        chat_external_id: &ExternalId,
        message_external_id: &ExternalId,
    ) -> Result<(), MessengerError>;
}

/// Builder trait for creating messenger clients.
#[async_trait]
pub trait MessengerClientBuilder: Send + Sync {
    /// The concrete client type this builder creates.
    type Client: MessengerClient;

    /// Create a new client with the given configuration.
    async fn build(
        &self,
        auth_config: AuthConfig,
        session_store: Option<Box<dyn SessionStore>>,
    ) -> Result<Self::Client, MessengerError>;
}
