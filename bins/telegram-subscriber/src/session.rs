use std::sync::Arc;

use messanger_telegram::{ClonableLoginToken, ClonablePasswordToken, TelegramClient};
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
    pub login_token: Option<ClonableLoginToken>,
    pub password_token: Option<ClonablePasswordToken>,
    pub subscriber_handler: Option<TelegramSubscriberHandler>,
    pub qr_polling_handler: Option<QrPollingHandler>,
}
