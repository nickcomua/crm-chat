use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tdlib_rs::enums::{AuthorizationState, Update};
use tokio::sync::{mpsc, watch};

const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

static RECEIVER_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ChatKind {
    Dialog,
    Group,
    Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub kind: ChatKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    pub id: String,
    pub title: String,
    pub chats: Vec<Chat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Message {
    pub id: String,
    pub text: String,
    pub outgoing: bool,
    pub date: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "_tag")]
pub enum AuthStep {
    Code { id: String },
    Password { id: String },
    Qr { id: String, link: String },
    Authorized { account: Account },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    Opening,
    WaitPhone,
    WaitCode,
    WaitPassword,
    WaitQr(String),
    Ready,
    Closed,
    Failed(String),
}

struct Slot {
    directory: PathBuf,
    api_id: i32,
    api_hash: String,
    phase: watch::Sender<Phase>,
}

struct Shared {
    slots: Mutex<std::collections::HashMap<i32, Slot>>,
    ids: Mutex<std::collections::HashMap<String, i32>>,
}

pub struct Client {
    root: PathBuf,
    shared: Arc<Shared>,
    _runtime: tokio::runtime::Runtime,
}

pub fn database_root_from(data_home: &Path) -> PathBuf {
    data_home.join("app.crmchat.desktop").join("tdlib")
}

pub fn database_root() -> PathBuf {
    if let Ok(override_dir) = std::env::var("CRM_CHAT_TDLIB_DIR") {
        if !override_dir.is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
            home.join(".local").join("share")
        });
    database_root_from(&data_home)
}

/// Opens a throwaway TDLib database and asks Telegram for a QR login.
/// Success means the application credentials were accepted. The login link is
/// not returned. The temporary database is deleted.
pub async fn prove_application_credentials(api_id: i32, api_hash: &str) -> Result<(), String> {
    let root = std::env::temp_dir().join(format!("crm-chat-tdlib-prove-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let client = Client::open(root.clone())?;
    let step = client.begin_qr("probe", api_id, api_hash).await;
    let _ = client.logout("probe").await;
    let _ = std::fs::remove_dir_all(&root);
    match step {
        Ok(AuthStep::Qr { .. } | AuthStep::Authorized { .. } | AuthStep::Password { .. }) => Ok(()),
        Ok(AuthStep::Code { .. }) => Err("Telegram asked for a phone code during a QR check".into()),
        Err(error) => Err(error),
    }
}

pub fn chat_kind(type_name: &str, is_channel: bool) -> Option<ChatKind> {
    match type_name {
        "chatTypePrivate" | "chatTypeSecret" => Some(ChatKind::Dialog),
        "chatTypeBasicGroup" => Some(ChatKind::Group),
        "chatTypeSupergroup" if is_channel => Some(ChatKind::Channel),
        "chatTypeSupergroup" => Some(ChatKind::Group),
        _ => None,
    }
}

fn valid_account_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if ok {
        Ok(())
    } else {
        Err("account id is not a local identifier".into())
    }
}

fn public_error(value: &Value) -> Option<String> {
    if value.get("@type").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("REQUEST_FAILED");
    if !message.is_empty()
        && message
            .chars()
            .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_')
    {
        Some(message.to_owned())
    } else {
        Some("REQUEST_FAILED".into())
    }
}

fn phase_from_authorization(state: AuthorizationState) -> Phase {
    match state {
        AuthorizationState::WaitTdlibParameters => Phase::Opening,
        AuthorizationState::WaitPhoneNumber => Phase::WaitPhone,
        AuthorizationState::WaitCode(_) => Phase::WaitCode,
        AuthorizationState::WaitPassword(_) => Phase::WaitPassword,
        AuthorizationState::WaitOtherDeviceConfirmation(confirmation) => {
            Phase::WaitQr(confirmation.link)
        }
        AuthorizationState::Ready => Phase::Ready,
        AuthorizationState::Closed | AuthorizationState::Closing | AuthorizationState::LoggingOut => {
            Phase::Closed
        }
        AuthorizationState::WaitRegistration(_)
        | AuthorizationState::WaitEmailAddress(_)
        | AuthorizationState::WaitEmailCode(_)
        | AuthorizationState::WaitPremiumPurchase(_) => {
            Phase::Failed("Create your Telegram account in an official app first.".into())
        }
    }
}

impl Client {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        if RECEIVER_STARTED.swap(true, Ordering::SeqCst) {
            return Err("TDLib receiver is already running".into());
        }
        std::fs::create_dir_all(&root).map_err(|_| "could not create the TDLib directory".to_owned())?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_time()
            .build()
            .map_err(|_| "could not start the Telegram runtime".to_owned())?;
        let shared = Arc::new(Shared {
            slots: Mutex::new(std::collections::HashMap::new()),
            ids: Mutex::new(std::collections::HashMap::new()),
        });
        let (tx, mut rx) = mpsc::channel::<(Update, i32)>(256);
        let handler = Arc::clone(&shared);
        runtime.spawn(async move {
            while let Some((update, client_id)) = rx.recv().await {
                if let Update::AuthorizationState(update) = update {
                    apply_authorization(&handler, client_id, update.authorization_state).await;
                }
            }
        });
        std::thread::Builder::new()
            .name("tdlib-receive".into())
            .spawn(move || {
                loop {
                    if let Some(update) = tdlib_rs::receive() {
                        if tx.blocking_send(update).is_err() {
                            break;
                        }
                    }
                }
            })
            .map_err(|_| "could not start TDLib".to_owned())?;
        Ok(Self {
            root,
            shared,
            _runtime: runtime,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub async fn begin_phone(
        &self,
        id: &str,
        api_id: i32,
        api_hash: &str,
        phone: &str,
    ) -> Result<AuthStep, String> {
        let client_id = self.ensure(id, api_id, api_hash).await?;
        self.wait_until(client_id, OPEN_TIMEOUT, |phase| {
            matches!(phase, Phase::WaitPhone | Phase::Ready | Phase::Failed(_))
        })
        .await?;
        if matches!(self.phase(client_id), Phase::Ready) {
            return self.authorized(id, client_id).await;
        }
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "setAuthenticationPhoneNumber",
                "phone_number": phone,
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        self.step_after_request(id, client_id).await
    }

    pub async fn begin_qr(
        &self,
        id: &str,
        api_id: i32,
        api_hash: &str,
    ) -> Result<AuthStep, String> {
        let client_id = self.ensure(id, api_id, api_hash).await?;
        self.wait_until(client_id, OPEN_TIMEOUT, |phase| {
            matches!(
                phase,
                Phase::WaitPhone | Phase::WaitQr(_) | Phase::Ready | Phase::Failed(_)
            )
        })
        .await?;
        if matches!(self.phase(client_id), Phase::Ready) {
            return self.authorized(id, client_id).await;
        }
        if matches!(self.phase(client_id), Phase::WaitQr(_)) {
            return self.step_from_phase(id, client_id).await;
        }
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "requestQrCodeAuthentication",
                "other_user_ids": [],
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        self.step_after_request(id, client_id).await
    }

    pub async fn submit_code(&self, id: &str, code: &str) -> Result<AuthStep, String> {
        let client_id = self.client_id(id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({"@type": "checkAuthenticationCode", "code": code}),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        self.step_after_request(id, client_id).await
    }

    pub async fn submit_password(&self, id: &str, password: &str) -> Result<AuthStep, String> {
        let client_id = self.client_id(id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({"@type": "checkAuthenticationPassword", "password": password}),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        self.step_after_request(id, client_id).await
    }

    pub async fn poll(&self, id: &str) -> Result<AuthStep, String> {
        let client_id = self.client_id(id)?;
        self.step_from_phase(id, client_id).await
    }

    pub async fn load_account(&self, id: &str) -> Result<Account, String> {
        let client_id = self.client_id(id)?;
        if !matches!(self.phase(client_id), Phase::Ready) {
            return Err("account is not logged in".into());
        }
        self.read_account(id, client_id).await
    }

    pub async fn messages(&self, id: &str, chat_id: &str) -> Result<Vec<Message>, String> {
        let client_id = self.client_id(id)?;
        let td_chat_id = chat_tdlib_id(id, chat_id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "getChatHistory",
                "chat_id": td_chat_id,
                "from_message_id": 0,
                "offset": 0,
                "limit": 40,
                "only_local": false,
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        let messages = response
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut parsed = messages
            .iter()
            .filter_map(message_from_json)
            .collect::<Vec<_>>();
        parsed.reverse();
        Ok(parsed)
    }

    pub async fn logout(&self, id: &str) -> Result<(), String> {
        let Some(client_id) = self.ids().get(id).copied() else {
            return Ok(());
        };
        let response = tdlib_rs::send_json(client_id, json!({"@type": "logOut"})).await;
        if let Some(error) = public_error(&response) {
            if error != "REQUEST_FAILED" {
                return Err(error);
            }
        }
        let _ = self
            .wait_until(client_id, STEP_TIMEOUT, |phase| {
                matches!(phase, Phase::Closed | Phase::WaitPhone | Phase::Failed(_))
            })
            .await;
        self.ids().remove(id);
        Ok(())
    }

    pub async fn restore(&self, api_id: i32, api_hash: &str) -> Result<Vec<Account>, String> {
        let mut ids = std::fs::read_dir(&self.root)
            .map_err(|_| "could not read the TDLib directory".to_owned())?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|id| valid_account_id(id).is_ok())
            .collect::<Vec<_>>();
        ids.sort();
        let mut accounts = Vec::new();
        for id in ids {
            let client_id = self.ensure(&id, api_id, api_hash).await?;
            let phase = self
                .wait_until(client_id, OPEN_TIMEOUT, |phase| {
                    matches!(phase, Phase::Ready | Phase::WaitPhone | Phase::Failed(_))
                })
                .await
                .unwrap_or(Phase::Failed("timeout".into()));
            if matches!(phase, Phase::Ready) {
                accounts.push(self.read_account(&id, client_id).await?);
            }
        }
        Ok(accounts)
    }

    async fn ensure(&self, id: &str, api_id: i32, api_hash: &str) -> Result<i32, String> {
        valid_account_id(id)?;
        if api_id <= 0 || api_hash.len() != 32 {
            return Err("API_ID_INVALID".into());
        }
        if let Some(client_id) = self.ids().get(id).copied() {
            return Ok(client_id);
        }
        let directory = self.root.join(id);
        std::fs::create_dir_all(&directory)
            .map_err(|_| "could not create the account directory".to_owned())?;
        let directory = directory
            .canonicalize()
            .map_err(|_| "could not resolve the account directory".to_owned())?;
        let client_id = tdlib_rs::create_client();
        let (phase, _) = watch::channel(Phase::Opening);
        self.shared.slots.lock().expect("slots").insert(
            client_id,
            Slot {
                directory,
                api_id,
                api_hash: api_hash.to_owned(),
                phase,
            },
        );
        self.ids().insert(id.to_owned(), client_id);
        let response = tdlib_rs::send_json(
            client_id,
            json!({"@type": "setLogVerbosityLevel", "new_verbosity_level": 0}),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        Ok(client_id)
    }

    fn ids(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, i32>> {
        self.shared.ids.lock().expect("ids")
    }

    fn phase(&self, client_id: i32) -> Phase {
        self.shared
            .slots
            .lock()
            .expect("slots")
            .get(&client_id)
            .map(|slot| slot.phase.borrow().clone())
            .unwrap_or(Phase::Closed)
    }

    async fn wait_until(
        &self,
        client_id: i32,
        timeout: Duration,
        pred: impl Fn(&Phase) -> bool,
    ) -> Result<Phase, String> {
        let mut rx = {
            let slots = self.shared.slots.lock().expect("slots");
            let slot = slots.get(&client_id).ok_or("account is not open")?;
            slot.phase.subscribe()
        };
        let wait = async {
            loop {
                let current = rx.borrow().clone();
                if pred(&current) {
                    return current;
                }
                if rx.changed().await.is_err() {
                    return Phase::Closed;
                }
            }
        };
        match tokio::time::timeout(timeout, wait).await {
            Ok(phase) => Ok(phase),
            Err(_) => Err("Telegram did not answer in time".into()),
        }
    }

    async fn step_after_request(&self, id: &str, client_id: i32) -> Result<AuthStep, String> {
        self.wait_until(client_id, STEP_TIMEOUT, |phase| {
            matches!(
                phase,
                Phase::WaitCode
                    | Phase::WaitPassword
                    | Phase::WaitQr(_)
                    | Phase::Ready
                    | Phase::Failed(_)
                    | Phase::Closed
            )
        })
        .await?;
        self.step_from_phase(id, client_id).await
    }

    async fn step_from_phase(&self, id: &str, client_id: i32) -> Result<AuthStep, String> {
        match self.phase(client_id) {
            Phase::WaitCode => Ok(AuthStep::Code { id: id.to_owned() }),
            Phase::WaitPassword => Ok(AuthStep::Password { id: id.to_owned() }),
            Phase::WaitQr(link) => Ok(AuthStep::Qr {
                id: id.to_owned(),
                link,
            }),
            Phase::Ready => self.authorized(id, client_id).await,
            Phase::Failed(error) => Err(error),
            Phase::Closed => Err("Login expired. Add the account again.".into()),
            Phase::Opening | Phase::WaitPhone => Err("Telegram is still starting".into()),
        }
    }

    async fn authorized(&self, id: &str, client_id: i32) -> Result<AuthStep, String> {
        let account = self.read_account(id, client_id).await?;
        Ok(AuthStep::Authorized { account })
    }

    async fn read_account(&self, id: &str, client_id: i32) -> Result<Account, String> {
        let me = tdlib_rs::send_json(client_id, json!({"@type": "getMe"})).await;
        if let Some(error) = public_error(&me) {
            return Err(error);
        }
        let title = [me.get("first_name"), me.get("last_name")]
            .into_iter()
            .filter_map(|value| value.and_then(Value::as_str))
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let title = if title.is_empty() {
            "Telegram account".to_owned()
        } else {
            title
        };
        let _ = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "loadChats",
                "chat_list": {"@type": "chatListMain"},
                "limit": 100,
            }),
        )
        .await;
        let chats = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "getChats",
                "chat_list": {"@type": "chatListMain"},
                "limit": 100,
            }),
        )
        .await;
        if let Some(error) = public_error(&chats) {
            return Err(error);
        }
        let ids = chats
            .get("chat_ids")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut parsed = Vec::new();
        for chat_id in ids {
            let Some(td_chat_id) = chat_id.as_i64() else {
                continue;
            };
            let chat = tdlib_rs::send_json(
                client_id,
                json!({"@type": "getChat", "chat_id": td_chat_id}),
            )
            .await;
            if public_error(&chat).is_some() {
                continue;
            }
            let Some(kind) = chat.get("type").and_then(|value| {
                chat_kind(
                    value.get("@type").and_then(Value::as_str).unwrap_or(""),
                    value
                        .get("is_channel")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
            }) else {
                continue;
            };
            let chat_title = chat
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.is_empty())
                .unwrap_or("Unnamed chat");
            parsed.push(Chat {
                id: format!("{id}:{td_chat_id}"),
                title: chat_title.to_owned(),
                kind,
            });
        }
        Ok(Account {
            id: id.to_owned(),
            title,
            chats: parsed,
        })
    }

    fn client_id(&self, id: &str) -> Result<i32, String> {
        self.ids()
            .get(id)
            .copied()
            .ok_or_else(|| "Login expired. Add the account again.".into())
    }
}

async fn apply_authorization(shared: &Shared, client_id: i32, state: AuthorizationState) {
    if matches!(state, AuthorizationState::WaitTdlibParameters) {
        let parameters = {
            let slots = shared.slots.lock().expect("slots");
            let Some(slot) = slots.get(&client_id) else {
                return;
            };
            json!({
                "@type": "setTdlibParameters",
                "use_test_dc": false,
                "database_directory": slot.directory,
                "files_directory": slot.directory.join("files"),
                "database_encryption_key": "",
                "use_file_database": true,
                "use_chat_info_database": true,
                "use_message_database": true,
                "use_secret_chats": false,
                "api_id": slot.api_id,
                "api_hash": slot.api_hash,
                "system_language_code": "en",
                "device_model": "CRM Chat",
                "system_version": "",
                "application_version": "0.1.0",
            })
        };
        let response = tdlib_rs::send_json(client_id, parameters).await;
        if let Some(error) = public_error(&response) {
            if let Some(slot) = shared.slots.lock().expect("slots").get(&client_id) {
                let _ = slot.phase.send(Phase::Failed(error));
            }
        }
        return;
    }
    let phase = phase_from_authorization(state);
    if let Some(slot) = shared.slots.lock().expect("slots").get(&client_id) {
        let _ = slot.phase.send(phase);
    }
}

fn chat_tdlib_id(account_id: &str, chat_id: &str) -> Result<i64, String> {
    let raw = chat_id
        .strip_prefix(&format!("{account_id}:"))
        .unwrap_or(chat_id);
    raw.parse::<i64>()
        .map_err(|_| "chat id is not a local identifier".into())
}

fn message_from_json(value: &Value) -> Option<Message> {
    let id = value.get("id").and_then(Value::as_i64)?;
    let content = value.get("content")?;
    let type_name = content.get("@type").and_then(Value::as_str).unwrap_or("");
    let text = if type_name == "messageText" {
        content
            .pointer("/text/text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    } else if type_name.is_empty() {
        String::new()
    } else {
        type_name.trim_start_matches("message").to_owned()
    };
    Some(Message {
        id: id.to_string(),
        text,
        outgoing: value
            .get("is_outgoing")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        date: value.get("date").and_then(Value::as_i64).unwrap_or(0) as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::{chat_kind, chat_tdlib_id, database_root_from, public_error, valid_account_id, ChatKind};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn classifies_the_three_chat_kinds() {
        assert_eq!(chat_kind("chatTypePrivate", false), Some(ChatKind::Dialog));
        assert_eq!(chat_kind("chatTypeSecret", false), Some(ChatKind::Dialog));
        assert_eq!(chat_kind("chatTypeBasicGroup", false), Some(ChatKind::Group));
        assert_eq!(
            chat_kind("chatTypeSupergroup", false),
            Some(ChatKind::Group)
        );
        assert_eq!(
            chat_kind("chatTypeSupergroup", true),
            Some(ChatKind::Channel)
        );
        assert_eq!(chat_kind("chatTypeUnknown", false), None);
    }

    #[test]
    fn database_root_is_under_the_desktop_data_dir() {
        assert_eq!(
            database_root_from(Path::new("/data")),
            Path::new("/data/app.crmchat.desktop/tdlib")
        );
    }

    #[test]
    fn account_ids_cannot_escape_the_data_dir() {
        assert!(valid_account_id("account-1").is_ok());
        assert!(valid_account_id("../secret").is_err());
        assert!(valid_account_id("").is_err());
    }

    #[test]
    fn chat_ids_are_namespaced_by_the_local_account() {
        assert_eq!(chat_tdlib_id("one", "one:42").unwrap(), 42);
        assert!(chat_tdlib_id("one", "one:nope").is_err());
    }

    #[test]
    fn errors_keep_telegram_codes_and_drop_free_text() {
        assert_eq!(
            public_error(&json!({"@type": "error", "message": "PHONE_CODE_INVALID"})).as_deref(),
            Some("PHONE_CODE_INVALID")
        );
        assert_eq!(
            public_error(&json!({"@type": "error", "message": "phone +1 secret"})).as_deref(),
            Some("REQUEST_FAILED")
        );
        assert_eq!(public_error(&json!({"@type": "ok"})), None);
    }
}
