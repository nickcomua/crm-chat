use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tdlib_rs::enums::{AuthorizationState, Update};
use tokio::sync::{mpsc, watch};

const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

static RECEIVER_STARTED: AtomicBool = AtomicBool::new(false);

const LOG_SILENCE_REQUESTS: [&str; 2] = [
    r#"{"@type":"setLogVerbosityLevel","new_verbosity_level":0}"#,
    r#"{"@type":"setLogStream","log_stream":{"@type":"logStreamEmpty"}}"#,
];

/// TDLib defaults to verbose stderr logging, which includes phone numbers,
/// login codes, passwords, `api_hash`, and the database key. Both calls are
/// synchronous and must finish before a client exists and before `receive` runs.
fn silence_tdlib_logs() -> Result<(), String> {
    for request in LOG_SILENCE_REQUESTS {
        let response = tdlib_rs::execute(request).ok_or("could not silence TDLib logs")?;
        let value: Value =
            serde_json::from_str(&response).map_err(|_| "could not silence TDLib logs")?;
        if value.get("@type").and_then(Value::as_str) != Some("ok") {
            return Err("could not silence TDLib logs".into());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

/// A message TDLib pushed after the chat was already open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMessage {
    pub chat_id: String,
    pub id: String,
    pub text: String,
    pub outgoing: bool,
    pub date: i32,
}

/// Sponsored messages TDLib returns for a channel. Third-party clients have to show them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SponsoredPage {
    pub between: i32,
    pub messages: Vec<SponsoredLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SponsoredLine {
    pub id: String,
    pub text: String,
    pub title: String,
    pub button: String,
    pub recommended: bool,
    pub info: String,
}

struct StoredLive {
    account_id: String,
    message: LiveMessage,
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
    /// Advances when Telegram publishes a new authorization state, not when
    /// poll re-reads the current one. A login request waits until the phase
    /// itself changes, so a generation bump that leaves the phase in place
    /// does not finish the wait.
    generation: u64,
    parameters_sent: bool,
}

struct Shared {
    slots: Mutex<std::collections::HashMap<i32, Slot>>,
    ids: Mutex<std::collections::HashMap<String, i32>>,
    inbox: Mutex<Vec<StoredLive>>,
}

pub struct Client {
    root: PathBuf,
    shared: Arc<Shared>,
    _runtime: Option<tokio::runtime::Runtime>,
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
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
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
        Ok(AuthStep::Code { .. }) => {
            Err("Telegram asked for a phone code during a QR check".into())
        }
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

/// Exact title and kind. A chat of another kind with the same title is not a match.
pub fn chat_with_title<'a>(chats: &'a [Chat], title: &str, kind: ChatKind) -> Option<&'a Chat> {
    chats
        .iter()
        .find(|chat| chat.title == title && chat.kind == kind)
}

/// `Ok(None)` when nothing has this title. The same title with another kind is an
/// error so a caller does not create a second chat beside it.
pub fn locate_chat<'a>(
    chats: &'a [Chat],
    title: &str,
    kind: ChatKind,
) -> Result<Option<&'a Chat>, String> {
    if let Some(chat) = chat_with_title(chats, title, kind) {
        return Ok(Some(chat));
    }
    if chats.iter().any(|chat| chat.title == title) {
        return Err("listed as the wrong chat type".into());
    }
    Ok(None)
}

fn failed_add_count(value: &Value) -> usize {
    value
        .pointer("/failed_to_add_members/failed_to_add_members")
        .or_else(|| value.get("failed_to_add_members"))
        .and_then(Value::as_array)
        .map(|members| members.len())
        .unwrap_or(0)
}

fn chat_record(account_id: &str, value: &Value) -> Option<Chat> {
    if public_error(value).is_some() {
        return None;
    }
    let td_chat_id = value.get("id").and_then(Value::as_i64)?;
    let type_value = value.get("type")?;
    let kind = chat_kind(
        type_value
            .get("@type")
            .and_then(Value::as_str)
            .unwrap_or(""),
        type_value
            .get("is_channel")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )?;
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())?;
    Some(Chat {
        id: format!("{account_id}:{td_chat_id}"),
        title: title.to_owned(),
        kind,
    })
}

/// The desktop `Authorized` value is `{_tag: "Authorized", account}` with the
/// account id, title, and chats nested. Code and Password carry a top-level id.
/// Authorized does not.
pub fn require_desktop_authorized(account: &Account) -> Result<(), String> {
    let value = serde_json::to_value(&AuthStep::Authorized {
        account: account.clone(),
    })
    .map_err(|_| "could not encode Authorized".to_owned())?;
    let step = value
        .as_object()
        .ok_or("Authorized is not an object".to_owned())?;
    if step.len() != 2 || step.get("_tag").and_then(Value::as_str) != Some("Authorized") {
        return Err("desktop auth step is not Authorized".into());
    }
    let encoded = step
        .get("account")
        .and_then(Value::as_object)
        .ok_or("Authorized is missing the account".to_owned())?;
    if encoded.len() != 3 {
        return Err("Authorized account does not match the desktop shape".into());
    }
    let id = encoded
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Authorized account id is missing".to_owned())?;
    if id != account.id || valid_account_id(id).is_err() {
        return Err("Authorized account id is not a local identifier".into());
    }
    let title = encoded
        .get("title")
        .and_then(Value::as_str)
        .ok_or("Authorized account has no title".to_owned())?;
    if title.is_empty() || title != account.title {
        return Err("Authorized account has no title".into());
    }
    let chats = encoded
        .get("chats")
        .and_then(Value::as_array)
        .ok_or("Authorized account has no chats".to_owned())?;
    if chats.len() != account.chats.len() {
        return Err("Authorized chats do not match the desktop shape".into());
    }
    for (chat, expected) in chats.iter().zip(&account.chats) {
        let chat = chat
            .as_object()
            .ok_or("Authorized chat does not match the desktop shape".to_owned())?;
        if chat.len() != 3 {
            return Err("Authorized chat does not match the desktop shape".into());
        }
        let chat_id = chat
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Authorized chat id is missing".to_owned())?;
        let chat_title = chat
            .get("title")
            .and_then(Value::as_str)
            .ok_or("Authorized chat has no title".to_owned())?;
        let kind = chat
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("Authorized chat kind is missing".to_owned())?;
        if chat_id != expected.id || chat_title != expected.title || chat_title.is_empty() {
            return Err("Authorized chat does not match the desktop shape".into());
        }
        chat_tdlib_id(&account.id, chat_id)?;
        let expected_kind = match expected.kind {
            ChatKind::Dialog => "Dialog",
            ChatKind::Group => "Group",
            ChatKind::Channel => "Channel",
        };
        if kind != expected_kind {
            return Err("Authorized chat kind is not a desktop kind".into());
        }
    }
    Ok(())
}

fn valid_account_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        });
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
        && message.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
    {
        Some(message.to_owned())
    } else {
        Some("REQUEST_FAILED".into())
    }
}

fn phase_from_state_json(state: &serde_json::Value) -> Option<Phase> {
    match state.get("@type").and_then(serde_json::Value::as_str)? {
        "authorizationStateWaitTdlibParameters" => Some(Phase::Opening),
        "authorizationStateWaitPhoneNumber" => Some(Phase::WaitPhone),
        "authorizationStateWaitCode" => Some(Phase::WaitCode),
        "authorizationStateWaitPassword" => Some(Phase::WaitPassword),
        "authorizationStateWaitOtherDeviceConfirmation" => Some(Phase::WaitQr(
            state
                .get("link")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_owned(),
        )),
        "authorizationStateReady" => Some(Phase::Ready),
        "authorizationStateClosed"
        | "authorizationStateClosing"
        | "authorizationStateLoggingOut" => Some(Phase::Closed),
        _ => None,
    }
}

fn phase_from_update_json(value: &serde_json::Value) -> Option<Phase> {
    let state = if value.get("@type").and_then(serde_json::Value::as_str)
        == Some("updateAuthorizationState")
    {
        value.get("authorization_state")?
    } else {
        value
    };
    phase_from_state_json(state)
}

fn apply_refreshed_phase(phase: &watch::Sender<Phase>, next: Phase) {
    if phase.borrow().clone() != next {
        publish(phase, next);
    }
}

fn publish(phase: &watch::Sender<Phase>, next: Phase) {
    // send() discards the value when no one is subscribed. ensure() drops the
    // initial receiver, and poll does not subscribe, so Ready never replaced
    // WaitQr. send_replace keeps the value for the next borrow.
    phase.send_replace(next);
}

fn publish_authorization(slot: &mut Slot, next: Phase) {
    // Bump before send_replace so a waiter woken by changed() reads the new
    // generation.
    slot.generation += 1;
    publish(&slot.phase, next);
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
        AuthorizationState::Closed
        | AuthorizationState::Closing
        | AuthorizationState::LoggingOut => Phase::Closed,
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
        // The receive thread is spawned only after every fallible step below.
        // Clearing the flag on error lets a later open try again.
        match Self::open_receiver(root) {
            Ok(client) => Ok(client),
            Err(error) => {
                RECEIVER_STARTED.store(false, Ordering::SeqCst);
                Err(error)
            }
        }
    }

    fn open_receiver(root: PathBuf) -> Result<Self, String> {
        silence_tdlib_logs()?;
        std::fs::create_dir_all(&root)
            .map_err(|_| "could not create the TDLib directory".to_owned())?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_time()
            .build()
            .map_err(|_| "could not start the Telegram runtime".to_owned())?;
        let shared = Arc::new(Shared {
            slots: Mutex::new(std::collections::HashMap::new()),
            ids: Mutex::new(std::collections::HashMap::new()),
            inbox: Mutex::new(Vec::new()),
        });
        let (tx, mut rx) = mpsc::channel::<String>(256);
        let handler = Arc::clone(&shared);
        runtime.spawn(async move {
            while let Some(raw) = rx.recv().await {
                if let Some((Update::AuthorizationState(update), client_id)) =
                    tdlib_rs::decode_incoming(&raw)
                {
                    apply_authorization(&handler, client_id, update.authorization_state).await;
                }
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    note_live_update(&handler, &value);
                }
            }
        });
        std::thread::Builder::new()
            .name("tdlib-receive".into())
            .spawn(move || loop {
                if let Some(raw) = tdlib_rs::receive_payload() {
                    if tx.blocking_send(raw).is_err() {
                        break;
                    }
                }
            })
            .map_err(|_| "could not start TDLib".to_owned())?;
        Ok(Self {
            root,
            shared,
            _runtime: Some(runtime),
        })
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        if let Some(runtime) = self._runtime.take() {
            std::thread::spawn(move || drop(runtime)).join().ok();
        }
    }
}

impl Client {
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
        self.wait_until(client_id, OPEN_TIMEOUT, |_, phase| {
            matches!(phase, Phase::WaitPhone | Phase::Ready | Phase::Failed(_))
        })
        .await?;
        if matches!(self.phase(client_id), Phase::Ready) {
            return self.authorized(id, client_id).await;
        }
        let seen = self.phase(client_id);
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
        self.step_after_request(id, client_id, seen).await
    }

    pub async fn begin_qr(
        &self,
        id: &str,
        api_id: i32,
        api_hash: &str,
    ) -> Result<AuthStep, String> {
        let client_id = self.ensure(id, api_id, api_hash).await?;
        self.wait_until(client_id, OPEN_TIMEOUT, |_, phase| {
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
        let seen = self.phase(client_id);
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
        self.step_after_request(id, client_id, seen).await
    }

    pub async fn submit_code(&self, id: &str, code: &str) -> Result<AuthStep, String> {
        let client_id = self.client_id(id)?;
        let seen = self.phase(client_id);
        let response = tdlib_rs::send_json(
            client_id,
            json!({"@type": "checkAuthenticationCode", "code": code}),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        self.step_after_request(id, client_id, seen).await
    }

    pub async fn submit_password(&self, id: &str, password: &str) -> Result<AuthStep, String> {
        let client_id = self.client_id(id)?;
        let seen = self.phase(client_id);
        let response = tdlib_rs::send_json(
            client_id,
            json!({"@type": "checkAuthenticationPassword", "password": password}),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        self.step_after_request(id, client_id, seen).await
    }

    /// Confirms a QR login started on another client. The link is not logged.
    pub async fn confirm_qr(&self, id: &str, link: &str) -> Result<(), String> {
        if !link.starts_with("tg://login") {
            return Err("QR login link was not accepted".into());
        }
        let client_id = self.client_id(id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({"@type": "confirmQrCodeAuthentication", "link": link}),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        Ok(())
    }

    pub async fn poll(&self, id: &str) -> Result<AuthStep, String> {
        let client_id = self.client_id(id)?;
        let _ = tokio::time::timeout(Duration::from_secs(2), self.refresh_phase(client_id)).await;
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

    /// Supergroups and channels only deliver updates while the chat is open.
    pub async fn open_chat(&self, id: &str, chat_id: &str) -> Result<(), String> {
        self.chat_ok(id, chat_id, "openChat").await
    }

    pub async fn close_chat(&self, id: &str, chat_id: &str) -> Result<(), String> {
        self.chat_ok(id, chat_id, "closeChat").await
    }

    async fn chat_ok(&self, id: &str, chat_id: &str, method: &str) -> Result<(), String> {
        let client_id = self.client_id(id)?;
        let td_chat_id = chat_tdlib_id(id, chat_id)?;
        let response =
            tdlib_rs::send_json(client_id, json!({"@type": method, "chat_id": td_chat_id})).await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        Ok(())
    }

    pub fn take_incoming(&self, id: &str) -> Vec<LiveMessage> {
        let mut inbox = self.shared.inbox.lock().expect("inbox");
        let mut kept = Vec::new();
        let mut taken = Vec::new();
        for item in inbox.drain(..) {
            if item.account_id == id {
                taken.push(item.message);
            } else {
                kept.push(item);
            }
        }
        *inbox = kept;
        taken
    }

    pub async fn sponsored(&self, id: &str, chat_id: &str) -> Result<SponsoredPage, String> {
        let client_id = self.client_id(id)?;
        let td_chat_id = chat_tdlib_id(id, chat_id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "getChatSponsoredMessages",
                "chat_id": td_chat_id,
            }),
        )
        .await;
        sponsored_from_json(&response)
    }

    pub async fn self_user_id(&self, id: &str) -> Result<i64, String> {
        let client_id = self.client_id(id)?;
        let me = tdlib_rs::send_json(client_id, json!({"@type": "getMe"})).await;
        if let Some(error) = public_error(&me) {
            return Err(error);
        }
        me.get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "REQUEST_FAILED".to_owned())
    }

    /// Opens the private chat with `user_id` without sending a message.
    pub async fn create_private_chat(&self, id: &str, user_id: i64) -> Result<String, String> {
        let client_id = self.client_id(id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "createPrivateChat",
                "user_id": user_id,
                "force": false,
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        let td_chat_id = response
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "REQUEST_FAILED".to_owned())?;
        Ok(format!("{id}:{td_chat_id}"))
    }

    pub async fn send_text(&self, id: &str, chat_id: &str, text: &str) -> Result<(), String> {
        let client_id = self.client_id(id)?;
        let td_chat_id = chat_tdlib_id(id, chat_id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "sendMessage",
                "chat_id": td_chat_id,
                "input_message_content": {
                    "@type": "inputMessageText",
                    "text": {"@type": "formattedText", "text": text},
                },
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        Ok(())
    }

    /// Offline search, then a server search. Public-chat search is not used:
    /// it excludes the account's own chats. A matching title of the wrong kind
    /// is an error so the caller does not create a duplicate.
    pub async fn find_titled(
        &self,
        id: &str,
        title: &str,
        kind: ChatKind,
    ) -> Result<Option<Chat>, String> {
        let client_id = self.client_id(id)?;
        for method in ["searchChats", "searchChatsOnServer"] {
            let response = tdlib_rs::send_json(
                client_id,
                json!({
                    "@type": method,
                    "query": title,
                    "type_filter": null,
                    "limit": 20,
                }),
            )
            .await;
            if let Some(error) = public_error(&response) {
                return Err(error);
            }
            let ids = response
                .get("chat_ids")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut wrong_kind = false;
            for chat_id in ids {
                let Some(td_chat_id) = chat_id.as_i64() else {
                    continue;
                };
                let chat = tdlib_rs::send_json(
                    client_id,
                    json!({"@type": "getChat", "chat_id": td_chat_id}),
                )
                .await;
                let Some(parsed) = chat_record(id, &chat) else {
                    continue;
                };
                if parsed.title != title {
                    continue;
                }
                if parsed.kind == kind {
                    return Ok(Some(parsed));
                }
                wrong_kind = true;
            }
            if wrong_kind {
                return Err("listed as the wrong chat type".into());
            }
        }
        Ok(None)
    }

    /// Private basic group. The creator is a member; `user_ids` are the only
    /// other members. A non-empty failure list is returned without those ids.
    pub async fn create_basic_group(
        &self,
        id: &str,
        user_ids: &[i64],
        title: &str,
    ) -> Result<String, String> {
        let client_id = self.client_id(id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "createNewBasicGroupChat",
                "user_ids": user_ids,
                "title": title,
                "message_auto_delete_time": 0,
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        if failed_add_count(&response) > 0 {
            return Err("could not add the other test account".into());
        }
        let td_chat_id = response
            .get("chat_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "REQUEST_FAILED".to_owned())?;
        Ok(format!("{id}:{td_chat_id}"))
    }

    /// Private channel. No username is set, so the chat stays private.
    pub async fn create_channel(&self, id: &str, title: &str) -> Result<String, String> {
        let client_id = self.client_id(id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "createNewSupergroupChat",
                "title": title,
                "is_forum": false,
                "is_channel": true,
                "description": "",
                "location": null,
                "message_auto_delete_time": 0,
                "for_import": false,
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        let td_chat_id = response
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "REQUEST_FAILED".to_owned())?;
        Ok(format!("{id}:{td_chat_id}"))
    }

    /// Adds one user. `USER_ALREADY_PARTICIPANT` is success. `forward_limit` is
    /// 0 so earlier history is not copied to the new member.
    pub async fn add_member(&self, id: &str, chat_id: &str, user_id: i64) -> Result<(), String> {
        let client_id = self.client_id(id)?;
        let td_chat_id = chat_tdlib_id(id, chat_id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "addChatMember",
                "chat_id": td_chat_id,
                "user_id": user_id,
                "forward_limit": 0,
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            if error == "USER_ALREADY_PARTICIPANT" {
                return Ok(());
            }
            return Err(error);
        }
        if failed_add_count(&response) > 0 {
            return Err("could not add the other test account".into());
        }
        Ok(())
    }

    /// Lets one member post in a channel. Every other administrator right stays off.
    pub async fn grant_channel_post(
        &self,
        id: &str,
        chat_id: &str,
        user_id: i64,
    ) -> Result<(), String> {
        let client_id = self.client_id(id)?;
        let td_chat_id = chat_tdlib_id(id, chat_id)?;
        let response = tdlib_rs::send_json(
            client_id,
            json!({
                "@type": "setChatMemberStatus",
                "chat_id": td_chat_id,
                "member_id": {"@type": "messageSenderUser", "user_id": user_id},
                "status": {
                    "@type": "chatMemberStatusAdministrator",
                    "can_be_edited": true,
                    "rights": {
                        "@type": "chatAdministratorRights",
                        "can_manage_chat": true,
                        "can_change_info": false,
                        "can_post_messages": true,
                        "can_edit_messages": false,
                        "can_delete_messages": false,
                        "can_invite_users": false,
                        "can_restrict_members": false,
                        "can_pin_messages": false,
                        "can_manage_topics": false,
                        "can_promote_members": false,
                        "can_manage_video_chats": false,
                        "can_post_stories": false,
                        "can_edit_stories": false,
                        "can_delete_stories": false,
                        "can_manage_direct_messages": false,
                        "can_manage_tags": false,
                        "can_send_welcome_messages": false,
                        "is_anonymous": false,
                    },
                },
            }),
        )
        .await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        Ok(())
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
            .wait_until(client_id, STEP_TIMEOUT, |_, phase| {
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
                .wait_until(client_id, OPEN_TIMEOUT, |_, phase| {
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
                generation: 0,
                parameters_sent: false,
            },
        );
        self.ids().insert(id.to_owned(), client_id);
        send_parameters(&self.shared, client_id).await;
        Ok(client_id)
    }

    fn ids(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, i32>> {
        self.shared.ids.lock().expect("ids")
    }

    fn observed(&self, client_id: i32) -> Option<(u64, Phase)> {
        self.shared
            .slots
            .lock()
            .expect("slots")
            .get(&client_id)
            .map(|slot| (slot.generation, slot.phase.borrow().clone()))
    }

    fn phase(&self, client_id: i32) -> Phase {
        self.observed(client_id)
            .map(|(_, phase)| phase)
            .unwrap_or(Phase::Closed)
    }

    #[cfg(test)]
    fn generation(&self, client_id: i32) -> u64 {
        self.observed(client_id)
            .map(|(generation, _)| generation)
            .unwrap_or(0)
    }

    async fn refresh_phase(&self, client_id: i32) -> Result<Phase, String> {
        let response =
            tdlib_rs::send_json(client_id, json!({"@type": "getAuthorizationState"})).await;
        if let Some(error) = public_error(&response) {
            return Err(error);
        }
        if let Some(phase) = phase_from_update_json(&response) {
            if matches!(phase, Phase::Opening) {
                apply_authorization(
                    &self.shared,
                    client_id,
                    AuthorizationState::WaitTdlibParameters,
                )
                .await;
            } else if let Some(slot) = self.shared.slots.lock().expect("slots").get(&client_id) {
                // A re-read is not a new authorization, so the generation stays.
                // A different phase is still published: the update may have
                // been missed, and the waiter must not sit until the timeout.
                apply_refreshed_phase(&slot.phase, phase);
            }
        }
        Ok(self.phase(client_id))
    }

    async fn wait_until(
        &self,
        client_id: i32,
        timeout: Duration,
        pred: impl Fn(u64, &Phase) -> bool,
    ) -> Result<Phase, String> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            // Subscribe before reading so a publish between the read and the
            // wait still wakes this loop.
            let (mut rx, generation, phase) = {
                let slots = self.shared.slots.lock().expect("slots");
                let slot = slots.get(&client_id).ok_or("account is not open")?;
                let phase = slot.phase.borrow().clone();
                (slot.phase.subscribe(), slot.generation, phase)
            };
            if pred(generation, &phase) {
                return Ok(phase);
            }
            if std::time::Instant::now() >= deadline {
                return Err("Telegram did not answer in time".into());
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let slice = remaining.min(Duration::from_millis(500));
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        return Err("account is not open".into());
                    }
                }
                _ = tokio::time::sleep(slice) => {
                    let _ = tokio::time::timeout(slice, self.refresh_phase(client_id)).await;
                }
            }
        }
    }

    /// `seen` is the phase captured before the request was sent. The wait
    /// finishes when the phase is no longer that one. A generation bump that
    /// leaves the phase unchanged does not count, and a phase that already
    /// moved (including one recovered by `getAuthorizationState`) returns
    /// immediately instead of sitting until the timeout.
    async fn step_after_request(
        &self,
        id: &str,
        client_id: i32,
        seen: Phase,
    ) -> Result<AuthStep, String> {
        self.wait_until(client_id, STEP_TIMEOUT, move |_, phase| phase != &seen)
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
        match tokio::time::timeout(Duration::from_secs(5), self.read_account(id, client_id)).await {
            Ok(Ok(account)) => Ok(AuthStep::Authorized { account }),
            Ok(Err(_)) | Err(_) => Ok(AuthStep::Authorized {
                account: Account {
                    id: id.to_owned(),
                    title: "Telegram account".to_owned(),
                    chats: Vec::new(),
                },
            }),
        }
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
        if public_error(&chats).is_some() {
            return Ok(Account {
                id: id.to_owned(),
                title,
                chats: Vec::new(),
            });
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

fn apply_parameter_response(shared: &Shared, client_id: i32, response: &Value) {
    let Some(error) = public_error(response) else {
        return;
    };
    let mut slots = shared.slots.lock().expect("slots");
    let Some(slot) = slots.get_mut(&client_id) else {
        return;
    };
    // A second setTdlibParameters is a free-text error. Storing it as Failed
    // after WaitQr or Ready leaves poll on the QR step. A real failure is
    // still recorded while parameters have not been accepted.
    let current = slot.phase.borrow().clone();
    if matches!(current, Phase::Opening) {
        publish_authorization(slot, Phase::Failed(error));
    }
}

async fn send_parameters(shared: &Shared, client_id: i32) {
    let parameters = {
        let mut slots = shared.slots.lock().expect("slots");
        let Some(slot) = slots.get_mut(&client_id) else {
            return;
        };
        if slot.parameters_sent {
            return;
        }
        slot.parameters_sent = true;
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
    apply_parameter_response(shared, client_id, &response);
}

async fn apply_authorization(shared: &Shared, client_id: i32, state: AuthorizationState) {
    if matches!(state, AuthorizationState::WaitTdlibParameters) {
        send_parameters(shared, client_id).await;
        return;
    }
    let phase = phase_from_authorization(state);
    if let Some(slot) = shared.slots.lock().expect("slots").get_mut(&client_id) {
        publish_authorization(slot, phase);
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
    Some(Message {
        id: id.to_string(),
        text: content_text(content),
        outgoing: value
            .get("is_outgoing")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        date: value.get("date").and_then(Value::as_i64).unwrap_or(0) as i32,
    })
}

fn content_text(content: &Value) -> String {
    let type_name = content.get("@type").and_then(Value::as_str).unwrap_or("");
    if type_name == "messageText" {
        return content
            .pointer("/text/text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
    }
    if type_name.is_empty() {
        return String::new();
    }
    type_name.trim_start_matches("message").to_owned()
}

fn account_id_for(shared: &Shared, client_id: i32) -> Option<String> {
    shared
        .ids
        .lock()
        .expect("ids")
        .iter()
        .find(|(_, id)| **id == client_id)
        .map(|(account_id, _)| account_id.clone())
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

const INBOX_LIMIT: usize = 200;

/// Records `updateNewMessage` and `updateChatLastMessage`. Other payloads,
/// including request responses, are ignored. Nothing from the payload is logged.
fn note_live_update(shared: &Shared, value: &Value) {
    if value.get("@extra").is_some() {
        return;
    }
    let type_name = value.get("@type").and_then(Value::as_str).unwrap_or("");
    let (message, fallback_chat) = match type_name {
        "updateNewMessage" => (value.get("message"), None),
        "updateChatLastMessage" => (value.get("last_message"), value.get("chat_id")),
        _ => return,
    };
    let Some(message) = message else {
        return;
    };
    if message.is_null() {
        return;
    }
    let Some(client_id) = json_i64(value.get("@client_id")).and_then(|id| i32::try_from(id).ok())
    else {
        return;
    };
    let Some(account_id) = account_id_for(shared, client_id) else {
        return;
    };
    let Some(parsed) = message_from_json(message) else {
        return;
    };
    if parsed.text.is_empty() {
        return;
    }
    let Some(td_chat) = json_i64(message.get("chat_id")).or_else(|| json_i64(fallback_chat)) else {
        return;
    };
    let chat_id = format!("{account_id}:{td_chat}");
    let mut inbox = shared.inbox.lock().expect("inbox");
    let duplicate = inbox.iter().any(|item| {
        item.account_id == account_id
            && item.message.chat_id == chat_id
            && item.message.id == parsed.id
    });
    if duplicate {
        return;
    }
    inbox.push(StoredLive {
        account_id,
        message: LiveMessage {
            chat_id,
            id: parsed.id,
            text: parsed.text,
            outgoing: parsed.outgoing,
            date: parsed.date,
        },
    });
    if inbox.len() > INBOX_LIMIT {
        let extra = inbox.len() - INBOX_LIMIT;
        inbox.drain(0..extra);
    }
}

fn sponsored_from_json(value: &Value) -> Result<SponsoredPage, String> {
    if let Some(error) = public_error(value) {
        return Err(error);
    }
    if value.get("@type").and_then(Value::as_str) != Some("sponsoredMessages") {
        return Err("REQUEST_FAILED".into());
    }
    let between = value
        .get("messages_between")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, i64::from(i32::MAX)) as i32;
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter_map(|message| {
                    let id = json_i64(message.get("message_id"))?;
                    let content = message.get("content")?;
                    let text = |key: &str| -> String {
                        message
                            .get(key)
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned()
                    };
                    Some(SponsoredLine {
                        id: id.to_string(),
                        text: content_text(content),
                        title: text("title"),
                        button: text("button_text"),
                        recommended: message
                            .get("is_recommended")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        info: text("additional_info"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(SponsoredPage { between, messages })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_authorization, apply_parameter_response, apply_refreshed_phase, chat_kind,
        chat_tdlib_id, chat_with_title, database_root_from, failed_add_count, locate_chat,
        note_live_update, phase_from_update_json, public_error, publish, publish_authorization,
        require_desktop_authorized, send_parameters, sponsored_from_json, valid_account_id,
        Account, AuthStep, Chat, ChatKind, Client, Phase, Shared, Slot, LOG_SILENCE_REQUESTS,
    };
    use serde_json::json;
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::Duration;
    use tdlib_rs::enums::AuthorizationState;
    use tdlib_rs::types::AuthorizationStateWaitOtherDeviceConfirmation;

    fn test_shared() -> Shared {
        Shared {
            slots: std::sync::Mutex::new(std::collections::HashMap::new()),
            ids: std::sync::Mutex::new(std::collections::HashMap::new()),
            inbox: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn insert_slot(shared: &Shared, client_id: i32, phase: Phase, parameters_sent: bool) {
        let (tx, _rx) = tokio::sync::watch::channel(phase);
        shared.slots.lock().expect("slots").insert(
            client_id,
            Slot {
                directory: Path::new("/tmp/crm-chat-tdlib-test").to_path_buf(),
                api_id: 1,
                api_hash: "0123456789abcdef0123456789abcdef".into(),
                phase: tx,
                generation: 0,
                parameters_sent,
            },
        );
    }

    fn slot_phase(shared: &Shared, client_id: i32) -> Phase {
        shared
            .slots
            .lock()
            .expect("slots")
            .get(&client_id)
            .expect("slot")
            .phase
            .borrow()
            .clone()
    }

    struct PayloadLog {
        lines: Mutex<Vec<String>>,
    }

    impl log::Log for PayloadLog {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.level() <= log::Level::Warn
        }

        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                self.lines
                    .lock()
                    .expect("log")
                    .push(record.args().to_string());
            }
        }

        fn flush(&self) {}
    }

    static PAYLOAD_LOG: PayloadLog = PayloadLog {
        lines: Mutex::new(Vec::new()),
    };

    #[test]
    fn authorization_updates_move_the_phase_from_qr_to_ready() {
        let shared = test_shared();
        let client_id = 7;
        insert_slot(&shared, client_id, Phase::Opening, true);
        // ensure() drops the watch receiver, and poll does not subscribe.
        // The slot must still end at Ready.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            apply_authorization(
                &shared,
                client_id,
                AuthorizationState::WaitOtherDeviceConfirmation(
                    AuthorizationStateWaitOtherDeviceConfirmation {
                        link: "tg://login?token=abc".into(),
                    },
                ),
            )
            .await;
            assert!(matches!(
                slot_phase(&shared, client_id),
                Phase::WaitQr(ref link) if link == "tg://login?token=abc"
            ));
            apply_authorization(&shared, client_id, AuthorizationState::Ready).await;
            let finished = tokio::time::timeout(
                Duration::from_millis(200),
                send_parameters(&shared, client_id),
            )
            .await;
            assert!(
                finished.is_ok(),
                "a second setTdlibParameters must not be sent"
            );
        });
        assert!(matches!(slot_phase(&shared, client_id), Phase::Ready));
        assert!(matches!(
            phase_from_update_json(&json!({"@type": "authorizationStateReady"})),
            Some(Phase::Ready)
        ));
    }

    fn client_with_slot(client_id: i32, phase: Phase) -> Client {
        let shared = test_shared();
        insert_slot(&shared, client_id, phase, true);
        Client {
            root: Path::new("/tmp/crm-chat-tdlib-test").to_path_buf(),
            shared: std::sync::Arc::new(shared),
            _runtime: None,
        }
    }

    fn advance(client: &Client, client_id: i32, phase: Phase) {
        let mut slots = client.shared.slots.lock().expect("slots");
        publish_authorization(slots.get_mut(&client_id).expect("slot"), phase);
    }

    #[tokio::test]
    async fn a_submitted_code_waits_for_the_next_authorization_state() {
        let client = client_with_slot(4, Phase::Opening);
        advance(&client, 4, Phase::WaitCode);
        assert_eq!(client.generation(4), 1);
        let seen = client.phase(4);
        let generation = client.generation(4);
        let mut waiting = std::pin::pin!(client.step_after_request("acct", 4, seen));
        tokio::select! {
            biased;
            step = &mut waiting => {
                panic!("returned the code step it was answering: {step:?}")
            }
            _ = tokio::task::yield_now() => {}
        }
        // A poll that re-reads WaitCode is not a new state, and neither is a
        // generation bump that leaves the phase in place.
        if let Some(slot) = client.shared.slots.lock().expect("slots").get_mut(&4) {
            apply_refreshed_phase(&slot.phase, Phase::WaitCode);
            publish_authorization(slot, Phase::WaitCode);
        }
        assert_eq!(client.generation(4), generation + 1);
        assert!(matches!(client.phase(4), Phase::WaitCode));
        tokio::select! {
            biased;
            step = &mut waiting => {
                panic!("a same-phase generation bump finished the wait: {step:?}")
            }
            _ = tokio::task::yield_now() => {}
        }
        advance(&client, 4, Phase::WaitPassword);
        let step = tokio::time::timeout(Duration::from_millis(500), waiting)
            .await
            .expect("timed out after the phase changed")
            .expect("step");
        assert_eq!(
            step,
            AuthStep::Password {
                id: "acct".to_owned()
            }
        );
    }

    #[tokio::test]
    async fn a_missed_authorization_update_does_not_wait_out_the_timeout() {
        let client = client_with_slot(6, Phase::WaitCode);
        let seen = client.phase(6);
        let generation = client.generation(6);
        if let Some(slot) = client.shared.slots.lock().expect("slots").get(&6) {
            apply_refreshed_phase(&slot.phase, Phase::WaitPassword);
        }
        assert_eq!(client.generation(6), generation);
        let step = tokio::time::timeout(
            Duration::from_millis(200),
            client.step_after_request("acct", 6, seen),
        )
        .await
        .expect("missed update hung until the timeout")
        .expect("step");
        assert_eq!(
            step,
            AuthStep::Password {
                id: "acct".to_owned()
            }
        );
    }

    #[tokio::test]
    async fn a_new_qr_link_is_a_new_generation() {
        let qr = |link: &str| {
            AuthorizationState::WaitOtherDeviceConfirmation(
                AuthorizationStateWaitOtherDeviceConfirmation {
                    link: link.to_owned(),
                },
            )
        };
        let client = client_with_slot(5, Phase::Opening);
        apply_authorization(&client.shared, 5, qr("tg://login?token=first")).await;
        let seen = client.phase(5);
        let mut waiting = std::pin::pin!(client.step_after_request("acct", 5, seen));
        tokio::select! {
            biased;
            step = &mut waiting => {
                panic!("returned the existing QR without a new generation: {step:?}")
            }
            _ = tokio::task::yield_now() => {}
        }
        apply_authorization(&client.shared, 5, qr("tg://login?token=second")).await;
        let step = tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .expect("timed out after the new generation")
            .expect("step");
        assert_eq!(
            step,
            AuthStep::Qr {
                id: "acct".to_owned(),
                link: "tg://login?token=second".to_owned(),
            }
        );
    }

    #[test]
    fn desktop_authorized_shape_is_a_nested_account() {
        let account = Account {
            id: "account-1".to_owned(),
            title: "Telegram account".to_owned(),
            chats: vec![
                Chat {
                    id: "account-1:7".to_owned(),
                    title: "Ada".to_owned(),
                    kind: ChatKind::Dialog,
                },
                Chat {
                    id: "account-1:8".to_owned(),
                    title: "Team".to_owned(),
                    kind: ChatKind::Group,
                },
                Chat {
                    id: "account-1:9".to_owned(),
                    title: "News".to_owned(),
                    kind: ChatKind::Channel,
                },
            ],
        };
        require_desktop_authorized(&account).unwrap();
        let value = serde_json::to_value(AuthStep::Authorized {
            account: account.clone(),
        })
        .unwrap();
        assert_eq!(value["_tag"], "Authorized");
        assert!(value.get("id").is_none());
        assert_eq!(value["account"]["id"], "account-1");
        assert_eq!(value["account"]["chats"][0]["kind"], "Dialog");
        assert_eq!(value["account"]["chats"][1]["kind"], "Group");
        assert_eq!(value["account"]["chats"][2]["kind"], "Channel");
    }

    #[test]
    fn a_duplicate_parameter_error_does_not_replace_qr_or_ready() {
        let shared = test_shared();
        let client_id = 9;
        insert_slot(
            &shared,
            client_id,
            Phase::WaitQr("tg://login?token=abc".into()),
            true,
        );
        let error = json!({"@type": "error", "message": "Unexpected setTdlibParameters"});
        apply_parameter_response(&shared, client_id, &error);
        assert!(matches!(
            slot_phase(&shared, client_id),
            Phase::WaitQr(ref link) if link == "tg://login?token=abc"
        ));
        publish(
            &shared
                .slots
                .lock()
                .expect("slots")
                .get(&client_id)
                .expect("slot")
                .phase,
            Phase::Ready,
        );
        apply_parameter_response(&shared, client_id, &error);
        assert!(matches!(slot_phase(&shared, client_id), Phase::Ready));
        publish(
            &shared
                .slots
                .lock()
                .expect("slots")
                .get(&client_id)
                .expect("slot")
                .phase,
            Phase::Opening,
        );
        apply_parameter_response(&shared, client_id, &error);
        assert!(matches!(
            slot_phase(&shared, client_id),
            Phase::Failed(ref message) if message == "REQUEST_FAILED"
        ));
    }

    #[test]
    fn classifies_the_three_chat_kinds() {
        assert_eq!(chat_kind("chatTypePrivate", false), Some(ChatKind::Dialog));
        assert_eq!(chat_kind("chatTypeSecret", false), Some(ChatKind::Dialog));
        assert_eq!(
            chat_kind("chatTypeBasicGroup", false),
            Some(ChatKind::Group)
        );
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
    fn a_titled_chat_matches_only_the_same_kind() {
        let chats = vec![
            Chat {
                id: "a:1".to_owned(),
                title: "crm-chat test group".to_owned(),
                kind: ChatKind::Group,
            },
            Chat {
                id: "a:2".to_owned(),
                title: "crm-chat test channel".to_owned(),
                kind: ChatKind::Channel,
            },
        ];
        assert_eq!(
            chat_with_title(&chats, "crm-chat test group", ChatKind::Group)
                .map(|chat| chat.id.as_str()),
            Some("a:1")
        );
        assert!(chat_with_title(&chats, "crm-chat test group", ChatKind::Channel).is_none());
        assert!(locate_chat(&chats, "crm-chat test group", ChatKind::Channel).is_err());
        assert!(
            locate_chat(&chats, "crm-chat test channel", ChatKind::Channel)
                .unwrap()
                .is_some()
        );
        assert!(locate_chat(&chats, "missing", ChatKind::Group)
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_adds_count_nested_and_top_level_lists() {
        let created = json!({
            "@type": "createdBasicGroupChat",
            "chat_id": 1,
            "failed_to_add_members": {
                "@type": "failedToAddMembers",
                "failed_to_add_members": [{"@type": "failedToAddMember"}]
            }
        });
        assert_eq!(failed_add_count(&created), 1);
        let empty = json!({
            "@type": "failedToAddMembers",
            "failed_to_add_members": []
        });
        assert_eq!(failed_add_count(&empty), 0);
        assert_eq!(failed_add_count(&json!({"@type": "ok"})), 0);
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
    fn log_silence_runs_before_a_client_and_names_no_secrets() {
        assert!(LOG_SILENCE_REQUESTS[0].contains("setLogVerbosityLevel"));
        assert!(LOG_SILENCE_REQUESTS[0].contains("\"new_verbosity_level\":0"));
        assert!(LOG_SILENCE_REQUESTS[1].contains("logStreamEmpty"));
        for request in LOG_SILENCE_REQUESTS {
            assert!(!request.contains("api_hash"));
            assert!(!request.contains("phone"));
            assert!(!request.contains("password"));
        }
    }

    #[test]
    fn a_failed_open_releases_the_receiver_flag() {
        let blocker =
            std::env::temp_dir().join(format!("crm-chat-open-blocker-{}", std::process::id()));
        let _ = std::fs::remove_file(&blocker);
        std::fs::write(&blocker, b"x").expect("blocker");
        let root = blocker.join("tdlib");
        let first = match Client::open(root.clone()) {
            Ok(_) => panic!("open succeeded"),
            Err(error) => error,
        };
        let second = match Client::open(root) {
            Ok(_) => panic!("open succeeded"),
            Err(error) => error,
        };
        let _ = std::fs::remove_file(&blocker);
        assert_ne!(first, "TDLib receiver is already running");
        assert_ne!(second, "TDLib receiver is already running");
        assert_eq!(first, "could not create the TDLib directory");
        assert_eq!(second, "could not create the TDLib directory");
    }

    #[test]
    fn unknown_tdlib_payloads_are_dropped_without_their_contents() {
        let _ = log::set_logger(&PAYLOAD_LOG);
        log::set_max_level(log::LevelFilter::Warn);
        let canary = "CANARY-api_hash-phone-code-password";
        let payloads = [
            "not-json",
            r#"{"@type":"updateNope","@client_id":1,"text":"CANARY-api_hash-phone-code-password"}"#,
            r#"{"@type":"updateAuthorizationState","authorization_state":{"@type":"authorizationStateReady"},"text":"CANARY-api_hash-phone-code-password"}"#,
            r#"{"@extra":"CANARY-api_hash-phone-code-password","@type":"ok"}"#,
        ];
        for payload in payloads {
            assert!(payload.contains(canary) || payload == "not-json");
            assert!(tdlib_rs::decode_incoming(payload).is_none());
        }
        let ready = tdlib_rs::decode_incoming(
            r#"{"@type":"updateAuthorizationState","@client_id":4,"authorization_state":{"@type":"authorizationStateReady"}}"#,
        )
        .expect("ready update");
        assert_eq!(ready.1, 4);
        assert!(matches!(
            ready.0,
            tdlib_rs::enums::Update::AuthorizationState(_)
        ));
        let logged = PAYLOAD_LOG.lines.lock().expect("log lines");
        assert!(logged.iter().all(|line| !line.contains(canary)));
    }

    #[test]
    fn a_new_message_is_kept_once_and_a_response_is_ignored() {
        let shared = test_shared();
        shared.ids.lock().expect("ids").insert("acct".to_owned(), 4);
        let update = json!({
            "@type": "updateNewMessage",
            "@client_id": 4,
            "message": {
                "id": 9,
                "chat_id": 7,
                "is_outgoing": false,
                "date": 30,
                "content": {"@type": "messageText", "text": {"text": "just arrived"}}
            }
        });
        note_live_update(&shared, &update);
        note_live_update(&shared, &update);
        note_live_update(
            &shared,
            &json!({
                "@extra": "q1",
                "@type": "message",
                "@client_id": 4,
                "id": 10,
                "chat_id": 7,
                "content": {"@type": "messageText", "text": {"text": "not live"}}
            }),
        );
        let client = Client {
            root: Path::new("/tmp/crm-chat-tdlib-test").to_path_buf(),
            shared: std::sync::Arc::new(shared),
            _runtime: None,
        };
        let taken = client.take_incoming("acct");
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].chat_id, "acct:7");
        assert_eq!(taken[0].id, "9");
        assert_eq!(taken[0].text, "just arrived");
        assert!(client.take_incoming("acct").is_empty());
    }

    #[test]
    fn sponsored_messages_keep_their_label_fields() {
        let page = sponsored_from_json(&json!({
            "@type": "sponsoredMessages",
            "messages_between": 0,
            "messages": [{
                "@type": "sponsoredMessage",
                "message_id": 4,
                "is_recommended": false,
                "content": {"@type": "messageText", "text": {"text": "Ride the ferry."}},
                "title": "Harbor",
                "button_text": "Open",
                "additional_info": "About this ad"
            }]
        }))
        .expect("page");
        assert_eq!(page.between, 0);
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].id, "4");
        assert_eq!(page.messages[0].text, "Ride the ferry.");
        assert_eq!(page.messages[0].title, "Harbor");
        assert_eq!(page.messages[0].button, "Open");
        assert!(!page.messages[0].recommended);
        assert_eq!(page.messages[0].info, "About this ad");
        assert_eq!(
            sponsored_from_json(&json!({"@type": "error", "message": "CHAT_NOT_FOUND"}))
                .expect_err("error"),
            "CHAT_NOT_FOUND"
        );
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
