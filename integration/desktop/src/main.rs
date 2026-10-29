//! Desktop-path Telegram check: grammers over TCP, the transport KAM-43 will use.
//!
//! Application credentials come from the process environment. The Nix app starts
//! this binary under `secretspec run --provider bws`. Nothing here prints secret
//! values, session contents, or vault identifiers.
//!
//! `login` writes a grammers sqlite session for one test account. `account`
//! loads that session. GramJS cannot open it; see `docs/secrets.md`.

mod login;
mod session_blob;

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
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

pub(crate) const TIMEOUT: Duration = Duration::from_secs(45);

struct Connected {
    client: Client,
    pool: JoinHandle<()>,
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
        Some("login") => {
            let session_out = args.next();
            let user_id_out = args.next();
            match (session_out, user_id_out, args.next()) {
                (Some(session_out), Some(user_id_out), None) => {
                    login::run(Path::new(&session_out), Path::new(&user_id_out)).await
                }
                _ => {
                    eprintln!("desktop: login expects a session path and a user-id path");
                    ExitCode::from(2)
                }
            }
        }
        _ => {
            eprintln!("desktop: expected subcommand credentials, account, or login");
            ExitCode::from(2)
        }
    }
}

pub(crate) fn require_app_credentials() -> Result<(i32, String), ExitCode> {
    parse_credentials("TG_ID", "TG_HASH", "app")
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

pub(crate) async fn connect<S>(api_id: i32, session: Arc<S>) -> Result<Connected, InvocationError>
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

pub(crate) async fn shutdown(connected: Connected) {
    drop(connected.client);
    connected.pool.abort();
    let _ = connected.pool.await;
}

pub(crate) fn describe(error: &InvocationError) -> String {
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
    let (api_id, _api_hash) = match require_app_credentials() {
        Ok(credentials) => credentials,
        Err(code) => return code,
    };
    let mut failed = false;
    for slot in [1, 2] {
        if let Err(message) = check_slot(api_id, slot).await {
            eprintln!("authenticated: {message}");
            failed = true;
        }
    }
    if failed {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

async fn check_slot(api_id: i32, slot: u8) -> Result<(), String> {
    let session_key = format!("TG_SESSION_GRAMMERS_{slot}");
    let user_key = format!("TG_USER_NUMERIC_ID_{slot}");
    let session = env::var(&session_key).unwrap_or_default();
    let user = env::var(&user_key).unwrap_or_default();
    if session.is_empty() && user.is_empty() {
        println!("authenticated: skipped, slot {slot} secrets did not resolve");
        return Ok(());
    }
    if session.is_empty() {
        return Err(format!(
            "slot {slot} has {user_key} but {session_key} did not resolve"
        ));
    }
    let Some(expected) = numeric_user_id(&user) else {
        return Err(format!(
            "slot {slot} has a session but {user_key} is not a numeric Telegram user id"
        ));
    };
    match timeout(TIMEOUT, prove_account(api_id, &session, expected, slot)).await {
        Ok(Ok(())) => {
            println!("authenticated: pass (desktop grammers tcp, slot {slot})");
            Ok(())
        }
        Ok(Err(message)) => Err(format!("slot {slot}: {message}")),
        Err(_) => Err(format!("slot {slot} timed out")),
    }
}

async fn prove_account(api_id: i32, encoded: &str, expected: i64, slot: u8) -> Result<(), String> {
    let (database, wal) = session_blob::unpack(encoded)?;
    let dir = env::temp_dir().join(format!(
        "crm-chat-integration-{}-{slot}",
        std::process::id()
    ));
    let path = dir.join("account.session");
    let opened = match write_session(&dir, &path, &database, &wal) {
        Ok(()) => SqliteSession::open(&path).await,
        Err(message) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(message);
        }
    };
    let result = match opened {
        Ok(session) => {
            let connected = connect(api_id, Arc::new(session))
                .await
                .map_err(|error| format!("tcp connect failed ({})", describe(&error)))?;
            let checked = check_self(&connected.client, expected).await;
            shutdown(connected).await;
            checked
        }
        Err(_) => Err("could not open the grammers session".to_string()),
    };
    let _ = fs::remove_dir_all(&dir);
    result
}

fn write_session(dir: &Path, path: &Path, database: &[u8], wal: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|_| "could not create a temporary session directory".to_string())?;
    write_private(path, database)?;
    if !wal.is_empty() {
        write_private(&wal_path(path), wal)?;
    }
    Ok(())
}

fn wal_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push("-wal");
    path.with_file_name(name)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "could not write the session file".to_string())?;
    file.write_all(bytes)
        .map_err(|_| "could not write the session file".to_string())?;
    Ok(())
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
        return Err("user id does not match the stored id".to_string());
    }
    Ok(())
}

fn numeric_user_id(value: &str) -> Option<i64> {
    let mut chars = value.chars();
    let first = chars.next()?;
    if !('1'..='9').contains(&first) || !chars.all(|character| character.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}
