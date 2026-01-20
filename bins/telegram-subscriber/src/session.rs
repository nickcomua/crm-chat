use std::sync::Arc;

use grammers_client::client::{LoginToken, PasswordToken};
use messanger_telegram::TelegramClient;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub struct TelegramSubscriberHandler {
    pub handler: JoinHandle<()>,
    pub cancel: CancellationToken,
}

pub struct QrPollingHandler {
    pub handler: JoinHandle<()>,
    pub cancel: CancellationToken,
}

pub struct Session {
    pub telegram_client: Arc<TelegramClient>,
    pub login_token: Option<LoginToken>,
    pub password_token: Option<PasswordToken>,
    pub subscriber_handler: Option<TelegramSubscriberHandler>,
    pub qr_polling_handler: Option<QrPollingHandler>,
}
