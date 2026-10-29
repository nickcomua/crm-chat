//! One-time grammers login. Prompts on `/dev/tty` and writes the session blob
//! and numeric user id to the paths it was given. It does not print those
//! values, the phone number, the login code, or the 2FA password.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::Arc;
use std::time::Duration;

use grammers_client::SignInError;
use grammers_session::storages::SqliteSession;
use tokio::time::timeout;

use crate::{connect, describe, require_app_credentials, shutdown, TIMEOUT};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(45);

pub async fn run(session_out: &Path, user_id_out: &Path) -> ExitCode {
    let (api_id, api_hash) = match require_app_credentials() {
        Ok(credentials) => credentials,
        Err(code) => return code,
    };
    let dir = std::env::temp_dir().join(format!(
        "crm-chat-login-{}-{}",
        std::process::id(),
        std::process::id()
    ));
    let outcome = login(api_id, &api_hash, &dir, session_out, user_id_out).await;
    let _ = fs::remove_dir_all(&dir);
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            tell(&format!("login-test-account: {message}"));
            eprintln!("login-test-account: {message}");
            ExitCode::from(1)
        }
    }
}

async fn login(
    api_id: i32,
    api_hash: &str,
    dir: &Path,
    session_out: &Path,
    user_id_out: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|_| "could not create a temporary session directory")?;
    let session_path = dir.join("account.session");
    let opened = SqliteSession::open(&session_path).await;
    let session = opened.map_err(|_| "could not create a session file")?;
    let connected = connect(api_id, Arc::new(session))
        .await
        .map_err(|error| format!("tcp connect failed ({})", describe(&error)))?;

    let phone = prompt_line("Phone number with country code (not saved): ")?;
    if phone.is_empty() {
        shutdown(connected).await;
        return Err("phone number is required".to_string());
    }
    tell("login-test-account: requesting a login code");
    let token = match timeout(
        LOGIN_TIMEOUT,
        connected.client.request_login_code(&phone, api_hash),
    )
    .await
    {
        Ok(Ok(token)) => token,
        Ok(Err(error)) => {
            shutdown(connected).await;
            return Err(format!(
                "could not request a login code ({})",
                describe(&error)
            ));
        }
        Err(_) => {
            shutdown(connected).await;
            return Err("login code request timed out".to_string());
        }
    };
    let code = prompt_line("Login code (not saved): ")?;
    if code.is_empty() {
        shutdown(connected).await;
        return Err("login code is required".to_string());
    }
    let signed_in = match timeout(LOGIN_TIMEOUT, connected.client.sign_in(&token, &code)).await {
        Ok(Ok(_)) => true,
        Ok(Err(SignInError::PasswordRequired(password_token))) => {
            let password = prompt_hidden("2FA password (hidden, not saved): ")?;
            if password.is_empty() {
                shutdown(connected).await;
                return Err("2FA password is required".to_string());
            }
            match timeout(
                LOGIN_TIMEOUT,
                connected
                    .client
                    .check_password(password_token, password.as_bytes()),
            )
            .await
            {
                Ok(Ok(_)) => true,
                Ok(Err(SignInError::InvalidPassword(_))) => {
                    shutdown(connected).await;
                    return Err("2FA password was rejected".to_string());
                }
                Ok(Err(SignInError::SignUpRequired)) => {
                    shutdown(connected).await;
                    return Err(signup_required());
                }
                Ok(Err(error)) => {
                    shutdown(connected).await;
                    return Err(format!("2FA failed ({})", sign_in_label(&error)));
                }
                Err(_) => {
                    shutdown(connected).await;
                    return Err("2FA check timed out".to_string());
                }
            }
        }
        Ok(Err(SignInError::SignUpRequired)) => {
            shutdown(connected).await;
            return Err(signup_required());
        }
        Ok(Err(SignInError::InvalidCode)) => {
            shutdown(connected).await;
            return Err("login code was rejected".to_string());
        }
        Ok(Err(error)) => {
            shutdown(connected).await;
            return Err(format!("sign-in failed ({})", sign_in_label(&error)));
        }
        Err(_) => {
            shutdown(connected).await;
            return Err("sign-in timed out".to_string());
        }
    };
    if !signed_in {
        shutdown(connected).await;
        return Err("sign-in failed".to_string());
    }
    let me = match timeout(TIMEOUT, connected.client.get_me()).await {
        Ok(Ok(me)) => me,
        Ok(Err(error)) => {
            shutdown(connected).await;
            return Err(format!("getMe failed ({})", describe(&error)));
        }
        Err(_) => {
            shutdown(connected).await;
            return Err("getMe timed out".to_string());
        }
    };
    let user_id = me
        .id()
        .bot_api_dialog_id()
        .filter(|id| *id > 0)
        .ok_or_else(|| "getMe did not return a numeric user id".to_string())?;
    shutdown(connected).await;
    let encoded = read_session(&session_path)?;
    write_private(session_out, encoded.as_bytes())?;
    write_private(user_id_out, user_id.to_string().as_bytes())?;
    tell("login-test-account: signed in");
    Ok(())
}

fn signup_required() -> String {
    "this phone is not registered. Create the account in an official app first".to_string()
}

fn sign_in_label(error: &SignInError) -> String {
    match error {
        SignInError::SignUpRequired => "sign-up required".to_string(),
        SignInError::PasswordRequired(_) => "2fa password required".to_string(),
        SignInError::InvalidCode => "invalid code".to_string(),
        SignInError::InvalidPassword(_) => "invalid password".to_string(),
        SignInError::Other(error) => describe(error),
    }
}

fn read_session(path: &Path) -> Result<String, String> {
    let database = fs::read(path).map_err(|_| "session was not saved".to_string())?;
    let wal_path = wal_path(path);
    let wal = if wal_path.is_file() {
        fs::read(&wal_path).map_err(|_| "session was not saved".to_string())?
    } else {
        Vec::new()
    };
    crate::session_blob::pack(&database, &wal)
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
        .map_err(|_| "could not write the login result".to_string())?;
    file.write_all(bytes)
        .map_err(|_| "could not write the login result".to_string())?;
    Ok(())
}

fn tell(message: &str) {
    if let Ok(mut tty) = OpenOptions::new().write(true).open("/dev/tty") {
        let _ = writeln!(tty, "{message}");
    }
}

fn prompt_line(label: &str) -> Result<String, String> {
    let mut output = OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .map_err(|_| "a terminal is required".to_string())?;
    write!(output, "{label}").map_err(|_| "could not prompt".to_string())?;
    output.flush().map_err(|_| "could not prompt".to_string())?;
    let input = File::open("/dev/tty").map_err(|_| "a terminal is required".to_string())?;
    let mut line = String::new();
    BufReader::new(input)
        .read_line(&mut line)
        .map_err(|_| "could not read input".to_string())?;
    if line.ends_with('\n') {
        line.pop();
    }
    if line.ends_with('\r') {
        line.pop();
    }
    Ok(line.trim().to_string())
}

fn prompt_hidden(label: &str) -> Result<String, String> {
    let _restore = EchoHidden::hide()?;
    let mut output = OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .map_err(|_| "a terminal is required".to_string())?;
    write!(output, "{label}").map_err(|_| "could not prompt".to_string())?;
    output.flush().map_err(|_| "could not prompt".to_string())?;
    let input = File::open("/dev/tty").map_err(|_| "a terminal is required".to_string())?;
    let mut line = String::new();
    BufReader::new(input)
        .read_line(&mut line)
        .map_err(|_| "could not read input".to_string())?;
    let _ = writeln!(output);
    if line.ends_with('\n') {
        line.pop();
    }
    if line.ends_with('\r') {
        line.pop();
    }
    Ok(line)
}

struct EchoHidden;

impl EchoHidden {
    fn hide() -> Result<Self, String> {
        stty("-echo")?;
        Ok(Self)
    }
}

impl Drop for EchoHidden {
    fn drop(&mut self) {
        let _ = stty("echo");
    }
}

fn stty(flag: &str) -> Result<(), String> {
    let tty = File::open("/dev/tty").map_err(|_| "a terminal is required".to_string())?;
    let status = Command::new("stty")
        .arg(flag)
        .stdin(tty)
        .status()
        .map_err(|_| "could not hide input".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("could not hide input".to_string())
    }
}
