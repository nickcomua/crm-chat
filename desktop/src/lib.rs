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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![telegram_app_credentials])
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
