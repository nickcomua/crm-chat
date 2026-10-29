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
    if qr {
        client.begin_qr(&id, api_id, &api_hash).await
    } else {
        client.begin_phone(&id, api_id, &api_hash, &phone).await
    }
}

#[tauri::command]
async fn telegram_submit_code(
    app: tauri::AppHandle,
    id: String,
    code: String,
) -> Result<crm_chat_telegram::AuthStep, String> {
    client(&app)?.submit_code(&id, &code).await
}

#[tauri::command]
async fn telegram_submit_password(
    app: tauri::AppHandle,
    id: String,
    password: String,
) -> Result<crm_chat_telegram::AuthStep, String> {
    client(&app)?.submit_password(&id, &password).await
}

#[tauri::command]
async fn telegram_poll(
    app: tauri::AppHandle,
    id: String,
) -> Result<crm_chat_telegram::AuthStep, String> {
    client(&app)?.poll(&id).await
}

#[tauri::command]
async fn telegram_load_account(
    app: tauri::AppHandle,
    id: String,
) -> Result<crm_chat_telegram::Account, String> {
    client(&app)?.load_account(&id).await
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
    client(&app)?.logout(&id).await
}

#[tauri::command]
async fn telegram_restore(
    app: tauri::AppHandle,
    api_id: String,
    api_hash: String,
) -> Result<Vec<crm_chat_telegram::Account>, String> {
    let client = client(&app)?;
    client.restore(parse_api_id(&api_id)?, &api_hash).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TelegramState {
            client: std::sync::Mutex::new(None),
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
            telegram_restore
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::telegram_app_credentials_from;

    #[test]
    fn accepts_runtime_credentials_and_rejects_malformed_ones() {
        let hash = "0123456789abcdef0123456789abcdef";
        assert!(telegram_app_credentials_from("12345", hash).is_some());
        assert!(telegram_app_credentials_from("0123", hash).is_none());
        assert!(telegram_app_credentials_from("12345", "short").is_none());
    }
}
