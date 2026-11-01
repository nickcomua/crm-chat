use tauri::Manager;

#[derive(serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TelegramAppCredentials {
    api_id: String,
    api_hash: String,
}

fn telegram_app_credentials_from(api_id: &str, api_hash: &str) -> Option<TelegramAppCredentials> {
    let id_ok = matches!(api_id.chars().next(), Some('1'..='9'))
        && api_id
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_digit());
    let hash_ok = api_hash.len() == 32
        && api_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if !id_ok || !hash_ok {
        return None;
    }
    Some(TelegramAppCredentials {
        api_id: api_id.to_owned(),
        api_hash: api_hash.to_owned(),
    })
}

#[tauri::command]
fn telegram_app_credentials() -> Option<TelegramAppCredentials> {
    let api_id = std::env::var("TG_ID").ok()?;
    let api_hash = std::env::var("TG_HASH").ok()?;
    telegram_app_credentials_from(&api_id, &api_hash)
}

struct TelegramState {
    client: std::sync::Mutex<Option<std::sync::Arc<crm_chat_telegram::Client>>>,
}

struct WorkspaceState {
    store: std::sync::Mutex<Result<crm_chat_workspace::Workspace, String>>,
    place: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStatus {
    schema_version: u32,
    path: String,
    notice: String,
}

#[derive(serde::Deserialize)]
struct RememberedAccount {
    id: String,
    title: String,
}

fn person_notes_unavailable(place: &str) -> String {
    format!("Person notes are unavailable ({place})")
}

fn open_workspace_state(app: &tauri::AppHandle) -> WorkspaceState {
    let place = app
        .path()
        .app_data_dir()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|_| "app data".to_owned());
    let store = match app.path().app_data_dir() {
        Ok(dir) => crm_chat_workspace::Workspace::open(&crm_chat_workspace::install_path(&dir))
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    WorkspaceState {
        store: std::sync::Mutex::new(store),
        place,
    }
}

fn with_workspace(app: &tauri::AppHandle, use_store: impl FnOnce(&crm_chat_workspace::Workspace)) {
    let Some(state) = app.try_state::<WorkspaceState>() else {
        return;
    };
    let Ok(guard) = state.store.lock() else {
        return;
    };
    if let Ok(store) = guard.as_ref() {
        use_store(store);
    }
}

fn remember_titles(app: &tauri::AppHandle, accounts: &[RememberedAccount]) {
    with_workspace(app, |store| {
        for account in accounts {
            let _ = store.remember_account(&account.id, &account.title);
        }
    });
}

fn remember_step(app: &tauri::AppHandle, step: &crm_chat_telegram::AuthStep) {
    if let crm_chat_telegram::AuthStep::Authorized { account } = step {
        remember_titles(
            app,
            &[RememberedAccount {
                id: account.id.clone(),
                title: account.title.clone(),
            }],
        );
    }
}

fn note_logged_out(app: &tauri::AppHandle, id: &str) {
    with_workspace(app, |store| {
        let _ = store.note_logout(id);
    });
}

fn client(app: &tauri::AppHandle) -> Result<std::sync::Arc<crm_chat_telegram::Client>, String> {
    let state = app
        .try_state::<TelegramState>()
        .ok_or("Telegram is not running")?;
    let mut guard = state.client.lock().expect("telegram state");
    if let Some(client) = guard.as_ref() {
        return Ok(std::sync::Arc::clone(client));
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "could not resolve the desktop data directory".to_owned())?
        .join("tdlib");
    let client = std::sync::Arc::new(crm_chat_telegram::Client::open(root)?);
    *guard = Some(std::sync::Arc::clone(&client));
    Ok(client)
}

fn parse_api_id(value: &str) -> Result<i32, String> {
    value.parse().map_err(|_| "API_ID_INVALID".to_owned())
}

#[tauri::command]
async fn telegram_begin_login(
    app: tauri::AppHandle,
    id: String,
    phone: String,
    qr: bool,
    api_id: String,
    api_hash: String,
) -> Result<crm_chat_telegram::AuthStep, String> {
    let client = client(&app)?;
    let api_id = parse_api_id(&api_id)?;
    let step = if qr {
        client.begin_qr(&id, api_id, &api_hash).await?
    } else {
        client.begin_phone(&id, api_id, &api_hash, &phone).await?
    };
    remember_step(&app, &step);
    Ok(step)
}

#[tauri::command]
async fn telegram_submit_code(
    app: tauri::AppHandle,
    id: String,
    code: String,
) -> Result<crm_chat_telegram::AuthStep, String> {
    let step = client(&app)?.submit_code(&id, &code).await?;
    remember_step(&app, &step);
    Ok(step)
}

#[tauri::command]
async fn telegram_submit_password(
    app: tauri::AppHandle,
    id: String,
    password: String,
) -> Result<crm_chat_telegram::AuthStep, String> {
    let step = client(&app)?.submit_password(&id, &password).await?;
    remember_step(&app, &step);
    Ok(step)
}

#[tauri::command]
async fn telegram_poll(
    app: tauri::AppHandle,
    id: String,
) -> Result<crm_chat_telegram::AuthStep, String> {
    let step = client(&app)?.poll(&id).await?;
    remember_step(&app, &step);
    Ok(step)
}

#[tauri::command]
async fn telegram_load_account(
    app: tauri::AppHandle,
    id: String,
) -> Result<crm_chat_telegram::Account, String> {
    let account = client(&app)?.load_account(&id).await?;
    remember_titles(
        &app,
        &[RememberedAccount {
            id: account.id.clone(),
            title: account.title.clone(),
        }],
    );
    Ok(account)
}

#[tauri::command]
async fn telegram_messages(
    app: tauri::AppHandle,
    id: String,
    chat_id: String,
) -> Result<Vec<crm_chat_telegram::Message>, String> {
    client(&app)?.messages(&id, &chat_id).await
}

#[tauri::command]
async fn telegram_logout(app: tauri::AppHandle, id: String) -> Result<(), String> {
    client(&app)?.logout(&id).await?;
    note_logged_out(&app, &id);
    Ok(())
}

#[tauri::command]
async fn telegram_restore(
    app: tauri::AppHandle,
    api_id: String,
    api_hash: String,
) -> Result<Vec<crm_chat_telegram::Account>, String> {
    let client = client(&app)?;
    let accounts = client.restore(parse_api_id(&api_id)?, &api_hash).await?;
    let remembered = accounts
        .iter()
        .map(|account| RememberedAccount {
            id: account.id.clone(),
            title: account.title.clone(),
        })
        .collect::<Vec<_>>();
    remember_titles(&app, &remembered);
    Ok(accounts)
}

#[tauri::command]
fn workspace_status(app: tauri::AppHandle) -> WorkspaceStatus {
    let Some(state) = app.try_state::<WorkspaceState>() else {
        return WorkspaceStatus {
            schema_version: 0,
            path: String::new(),
            notice: person_notes_unavailable("app data"),
        };
    };
    let Ok(guard) = state.store.lock() else {
        return WorkspaceStatus {
            schema_version: 0,
            path: String::new(),
            notice: person_notes_unavailable(&state.place),
        };
    };
    match guard.as_ref() {
        Ok(store) => WorkspaceStatus {
            schema_version: store.schema_version().unwrap_or(0),
            path: store.path().display().to_string(),
            notice: String::new(),
        },
        Err(_) => WorkspaceStatus {
            schema_version: 0,
            path: String::new(),
            notice: person_notes_unavailable(&state.place),
        },
    }
}

#[tauri::command]
fn workspace_remember_accounts(app: tauri::AppHandle, accounts: Vec<RememberedAccount>) {
    remember_titles(&app, &accounts);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TelegramState {
            client: std::sync::Mutex::new(None),
        })
        .setup(|app| {
            app.manage(open_workspace_state(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            telegram_app_credentials,
            telegram_begin_login,
            telegram_submit_code,
            telegram_submit_password,
            telegram_poll,
            telegram_load_account,
            telegram_messages,
            telegram_logout,
            telegram_restore,
            workspace_status,
            workspace_remember_accounts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{person_notes_unavailable, telegram_app_credentials_from};

    #[test]
    fn accepts_runtime_credentials_and_rejects_malformed_ones() {
        let hash = "0123456789abcdef0123456789abcdef";
        assert!(telegram_app_credentials_from("12345", hash).is_some());
        assert!(telegram_app_credentials_from("0123", hash).is_none());
        assert!(telegram_app_credentials_from("12345", "short").is_none());
    }

    #[test]
    fn a_storage_failure_names_the_data_directory() {
        assert_eq!(
            person_notes_unavailable("/home/ada/.local/share/app.crmchat.desktop"),
            "Person notes are unavailable (/home/ada/.local/share/app.crmchat.desktop)"
        );
    }
}
