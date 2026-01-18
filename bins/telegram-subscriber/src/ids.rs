use anyhow::Context;
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TelegramChatId {
    pub client_id: u64,
    pub dialog_external_id: String,
}

impl fmt::Display for TelegramChatId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:telegram:{}", self.client_id, self.dialog_external_id)
    }
}

impl From<TelegramChatId> for String {
    fn from(value: TelegramChatId) -> Self {
        value.to_string()
    }
}

impl TryFrom<String> for TelegramChatId {
    type Error = anyhow::Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let parts: Vec<&str> = value.split(':').collect();
        if parts.len() != 3 || parts[1] != "telegram" {
            return Err(anyhow::anyhow!("Invalid TelegramChatId format"));
        }
        Ok(TelegramChatId {
            client_id: parts[0].parse().context("Invalid client_id")?,
            dialog_external_id: parts[2].to_string(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TelegramMessageId {
    pub client_id: u64,
    pub dialog_external_id: String,
    pub message_external_id: String,
}

impl fmt::Display for TelegramMessageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:telegram:{}:{}",
            self.client_id, self.dialog_external_id, self.message_external_id
        )
    }
}

impl From<TelegramMessageId> for String {
    fn from(value: TelegramMessageId) -> Self {
        value.to_string()
    }
}

impl TryFrom<String> for TelegramMessageId {
    type Error = anyhow::Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let parts: Vec<&str> = value.split(':').collect();
        if parts.len() != 4 || parts[1] != "telegram" {
            return Err(anyhow::anyhow!("Invalid TelegramMessageId format"));
        }
        Ok(TelegramMessageId {
            client_id: parts[0].parse().context("Invalid client_id")?,
            dialog_external_id: parts[2].to_string(),
            message_external_id: parts[3].to_string(),
        })
    }
}
