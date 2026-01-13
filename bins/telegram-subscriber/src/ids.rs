use anyhow::Context;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TelegramChatId {
    pub client_id: u64,
    pub dialog_external_id: String,
}

impl ToString for TelegramChatId {
    fn to_string(&self) -> String {
        format!("{}:telegram:{}", self.client_id, self.dialog_external_id)
    }
}

impl Into<String> for TelegramChatId {
    fn into(self) -> String {
        self.to_string()
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

impl ToString for TelegramMessageId {
    fn to_string(&self) -> String {
        format!(
            "{}:telegram:{}:{}",
            self.client_id, self.dialog_external_id, self.message_external_id
        )
    }
}

impl Into<String> for TelegramMessageId {
    fn into(self) -> String {
        self.to_string()
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
