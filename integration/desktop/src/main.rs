//! Desktop-path Telegram check: grammers over TCP, the transport KAM-43 will use.
//!
//! Application credentials come from the process environment. The Nix app starts
//! this binary under `secretspec run --provider bws`. Nothing here prints secret
//! values, session contents, or vault identifiers.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use grammers_client::Client;
use grammers_mtsender::{ConnectionParams, InvocationError, SenderPool};
use grammers_session::storages::{MemorySession, SqliteSession};
use grammers_session::Session;
use grammers_tl_types as tl;
use tokio::task::JoinHandle;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(45);

struct Connected {
    client: Client,
    pool: JoinHandle<()>,
}

enum SessionLookup {
    Unset,
    Missing,
    Found(PathBuf),
}

enum UserIdLookup {
    Unset,
    NotNumeric,
    Numeric(i64),
}

fn main() -> ExitCode {
    let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(run());
    outcome
}

async fn run() -> ExitCode {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("credentials") => credentials_check().await,
        Some("account") => account_check().await,
        _ => {
            eprintln!("desktop: expected subcommand credentials or account");
            ExitCode::from(2)
        }
    }
}

fn require_app_credentials() -> Result<(i32, String), ExitCode> {
    parse_credentials("TG_ID", "TG_HASH", "app")
}

fn require_account_credentials() -> Result<(i32, String), ExitCode> {
    parse_credentials("TG_API_ID_1", "TG_API_HASH_1", "integration")
}

fn parse_credentials(id_key: &str, hash_key: &str, scope: &str) -> Result<(i32, String), ExitCode> {
    let api_id = env::var(id_key).unwrap_or_default();
    let api_hash = env::var(hash_key).unwrap_or_default();
    if api_id.is_empty() || api_hash.is_empty() {
        eprintln!(
            "desktop: {id_key} and {hash_key} did not resolve. Run this through secretspec run --provider bws --scope {scope}."
        );
        return Err(ExitCode::from(1));
    }
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
        eprintln!("desktop: resolved {id_key} or {hash_key} is not in the shape the apps accept");
        return Err(ExitCode::from(1));
    }
    let api_id = match api_id.parse::<i32>() {
        Ok(api_id) => api_id,
        Err(_) => {
            eprintln!("desktop: {id_key} does not fit in a Telegram api_id");
            return Err(ExitCode::from(1));
        }
    };
    Ok((api_id, api_hash))
}

async fn connect<S>(api_id: i32, session: Arc<S>) -> Result<Connected, InvocationError>
where
    S: Session + Sized,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let params = ConnectionParams {
        device_model: "CRM Chat Desktop".to_string(),
        ..ConnectionParams::default()
    };
    let SenderPool { runner, handle, .. } = SenderPool::with_configuration(session, api_id, params);
    let client = Client::new(handle);
    let pool = tokio::spawn(runner.run());
    Ok(Connected { client, pool })
}

async fn shutdown(connected: Connected) {
    drop(connected.client);
    connected.pool.abort();
    let _ = connected.pool.await;
}

fn describe(error: &InvocationError) -> String {
    match error {
        InvocationError::Rpc(rpc) => format!("rpc {}:{}", rpc.code, rpc.name),
        InvocationError::Io(_) => "io".to_string(),
        InvocationError::Transport(_) => "transport".to_string(),
        InvocationError::Session(_) => "session".to_string(),
        InvocationError::Deserialize(_) => "deserialize".to_string(),
        InvocationError::Dropped(_) => "dropped".to_string(),
        InvocationError::InvalidDc => "invalid-dc".to_string(),
        InvocationError::Authentication(_) => "authentication".to_string(),
    }
}

fn invalid_app(error: &InvocationError) -> bool {
    error.is("API_ID_INVALID") || error.is("API_ID_PUBLISHED_FLOOD")
}

async fn credentials_check() -> ExitCode {
    let (api_id, api_hash) = match require_app_credentials() {
        Ok(credentials) => credentials,
        Err(code) => return code,
    };
    let accepted = match timeout(TIMEOUT, prove_accepted(api_id, &api_hash)).await {
        Ok(Ok(())) => true,
        Ok(Err(message)) => {
            eprintln!("desktop: {message}");
            false
        }
        Err(_) => {
            eprintln!("desktop: credential check timed out");
            false
        }
    };
    if !accepted {
        return ExitCode::from(1);
    }
    let rejected = match timeout(TIMEOUT, prove_rejected()).await {
        Ok(Ok(())) => true,
        Ok(Err(message)) => {
            eprintln!("desktop: {message}");
            false
        }
        Err(_) => {
            eprintln!("desktop: invalid-credential check timed out");
            false
        }
    };
    if rejected {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

async fn prove_accepted(api_id: i32, api_hash: &str) -> Result<(), String> {
    let connected = connect(api_id, Arc::new(MemorySession::default()))
        .await
        .map_err(|error| format!("tcp connect failed ({})", describe(&error)))?;
    let config = connected
        .client
        .invoke(&tl::functions::help::GetConfig {})
        .await;
    let token = if config.is_ok() {
        export_login_token(&connected.client, api_id, api_hash)
            .await
            .map_err(|error| format!("exportLoginToken failed ({})", describe(&error)))
    } else {
        Err("help.getConfig failed".to_string())
    };
    shutdown(connected).await;
    let config = config.map_err(|error| format!("help.getConfig failed ({})", describe(&error)))?;
    let tl::enums::Config::Config(config) = config;
    if config.dc_options.is_empty() {
        return Err("help.getConfig returned no datacenters".to_string());
    }
    let label = token?;
    println!(
        "desktop grammers tcp: pass (help.getConfig dc_options={}, exportLoginToken={label})",
        config.dc_options.len()
    );
    Ok(())
}

async fn export_login_token(
    client: &Client,
    api_id: i32,
    api_hash: &str,
) -> Result<&'static str, InvocationError> {
    let result = client
        .invoke(&tl::functions::auth::ExportLoginToken {
            api_id,
            api_hash: api_hash.to_string(),
            except_ids: Vec::new(),
        })
        .await?;
    Ok(match result {
        tl::enums::auth::LoginToken::Token(_) => "token",
        tl::enums::auth::LoginToken::MigrateTo(_) => "migrate",
        tl::enums::auth::LoginToken::Success(_) => "success",
    })
}

async fn prove_rejected() -> Result<(), String> {
    let api_id = 1;
    let api_hash = "00000000000000000000000000000000";
    let connected = match connect(api_id, Arc::new(MemorySession::default())).await {
        Ok(connected) => connected,
        Err(error) if invalid_app(&error) => {
            println!("desktop grammers tcp: pass (invalid credentials rejected by connect)");
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "invalid credentials failed before the API check ({})",
                describe(&error)
            ));
        }
    };
    let rejected = export_login_token(&connected.client, api_id, api_hash).await;
    shutdown(connected).await;
    match rejected {
        Err(error) if invalid_app(&error) => {
            println!("desktop grammers tcp: pass (invalid credentials rejected)");
            Ok(())
        }
        Err(error) => Err(format!(
            "invalid credentials rejected with an unexpected error ({})",
            describe(&error)
        )),
        Ok(_) => Err("invalid credentials were accepted".to_string()),
    }
}

async fn account_check() -> ExitCode {
    let (api_id, _api_hash) = match require_account_credentials() {
        Ok(credentials) => credentials,
        Err(code) => return code,
    };
    let session = existing_session("TG_SESSION_FILE_1");
    let user_id = user_id("TG_USER_ID_1");
    let SessionLookup::Found(path) = session else {
        match session {
            SessionLookup::Unset => {
                println!("authenticated: skipped, TG_SESSION_FILE_1 did not resolve");
            }
            SessionLookup::Missing => {
                println!("authenticated: skipped, TG_SESSION_FILE_1 is not a file on this machine");
            }
            SessionLookup::Found(_) => {}
        }
        match user_id {
            UserIdLookup::NotNumeric => {
                println!("authenticated: TG_USER_ID_1 is not a numeric Telegram user id");
            }
            UserIdLookup::Unset => {
                println!("authenticated: TG_USER_ID_1 did not resolve");
            }
            UserIdLookup::Numeric(_) => {}
        }
        return ExitCode::SUCCESS;
    };
    let UserIdLookup::Numeric(expected) = user_id else {
        eprintln!("authenticated: session file is present but TG_USER_ID_1 is not a numeric Telegram user id");
        return ExitCode::from(1);
    };
    match timeout(TIMEOUT, prove_account(api_id, &path, expected)).await {
        Ok(Ok(())) => ExitCode::SUCCESS,
        Ok(Err(message)) => {
            eprintln!("authenticated: {message}");
            ExitCode::from(1)
        }
        Err(_) => {
            eprintln!("authenticated: timed out");
            ExitCode::from(1)
        }
    }
}

async fn prove_account(api_id: i32, source: &Path, expected: i64) -> Result<(), String> {
    let copy = copy_session(source)?;
    let opened = SqliteSession::open(&copy).await;
    let result = match opened {
        Ok(session) => {
            let connected = connect(api_id, Arc::new(session))
                .await
                .map_err(|error| format!("tcp connect failed ({})", describe(&error)))?;
            let checked = check_self(&connected.client, expected).await;
            shutdown(connected).await;
            checked
        }
        Err(_) => Err("could not open the session file".to_string()),
    };
    let _ = fs::remove_dir_all(copy.parent().unwrap_or(Path::new(".")));
    result
}

async fn check_self(client: &Client, expected: i64) -> Result<(), String> {
    let authorized = client
        .is_authorized()
        .await
        .map_err(|error| format!("authorization check failed ({})", describe(&error)))?;
    if !authorized {
        return Err("session is not authorized".to_string());
    }
    let me = client
        .get_me()
        .await
        .map_err(|error| format!("getMe failed ({})", describe(&error)))?;
    let actual = me
        .id()
        .bot_api_dialog_id()
        .ok_or_else(|| "getMe did not return a user id".to_string())?;
    if actual != expected {
        return Err("user id does not match TG_USER_ID_1".to_string());
    }
    println!("authenticated: pass");
    Ok(())
}

fn existing_session(key: &str) -> SessionLookup {
    let Ok(value) = env::var(key) else {
        return SessionLookup::Unset;
    };
    if value.is_empty() {
        return SessionLookup::Unset;
    }
    let path = PathBuf::from(&value);
    if path.is_file() {
        return SessionLookup::Found(path);
    }
    if let Some(joined) = invocation_join(&path) {
        if joined.is_file() {
            return SessionLookup::Found(joined);
        }
    }
    SessionLookup::Missing
}

fn invocation_join(path: &Path) -> Option<PathBuf> {
    if path.is_absolute() {
        return None;
    }
    let root = env::var("CRM_CHAT_INVOCATION_DIR").ok()?;
    Some(PathBuf::from(root).join(path))
}

fn user_id(key: &str) -> UserIdLookup {
    let Ok(value) = env::var(key) else {
        return UserIdLookup::Unset;
    };
    if value.is_empty() {
        return UserIdLookup::Unset;
    }
    match value.parse::<i64>() {
        Ok(id) if id > 0 => UserIdLookup::Numeric(id),
        _ => UserIdLookup::NotNumeric,
    }
}

fn copy_session(source: &Path) -> Result<PathBuf, String> {
    let dir = env::temp_dir().join(format!("crm-chat-integration-{}", std::process::id()));
    fs::create_dir_all(&dir)
        .map_err(|_| "could not create a temporary session copy".to_string())?;
    let dest = dir.join("account.session");
    fs::copy(source, &dest).map_err(|_| "could not copy the session file".to_string())?;
    Ok(dest)
}
