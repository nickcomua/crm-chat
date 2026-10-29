//! Desktop-path Telegram check and one-time login through TDLib.
//!
//! Prints pass lines and TDLib error codes only. Never print secrets,
//! database contents, phone numbers, login links, or user ids.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use crm_chat_telegram::{database_root, AuthStep, Client};

struct RemovedOnDrop(PathBuf);

impl Drop for RemovedOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn credentials_from_env() -> Result<(i32, String), String> {
    let api_id = std::env::var("TG_ID").map_err(|_| "TG_ID is unset".to_owned())?;
    let api_hash = std::env::var("TG_HASH").map_err(|_| "TG_HASH is unset".to_owned())?;
    let api_id = api_id
        .parse::<i32>()
        .map_err(|_| "TG_ID is not a Telegram application id".to_owned())?;
    if api_hash.len() != 32 {
        return Err("TG_HASH is not a Telegram application hash".into());
    }
    Ok((api_id, api_hash))
}

fn prompt(label: &str, hidden: bool) -> Result<String, String> {
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| "login needs a terminal".to_owned())?;
    writeln!(tty, "{label}").map_err(|_| "could not prompt".to_owned())?;
    if hidden {
        let _ = std::process::Command::new("stty")
            .arg("-echo")
            .spawn()
            .and_then(|mut child| child.wait());
    }
    let mut line = String::new();
    let mut reader =
        std::io::BufReader::new(tty.try_clone().map_err(|_| "could not read".to_owned())?);
    let read = reader.read_line(&mut line);
    if hidden {
        let _ = std::process::Command::new("stty")
            .arg("echo")
            .spawn()
            .and_then(|mut child| child.wait());
        let _ = writeln!(tty);
    }
    read.map_err(|_| "could not read the prompt".to_owned())?;
    Ok(line.trim().to_owned())
}

async fn credentials() -> Result<(), String> {
    let (api_id, api_hash) = credentials_from_env()?;
    crm_chat_telegram::prove_application_credentials(api_id, &api_hash).await?;
    println!("desktop tdlib: pass (application credentials accepted)");
    Ok(())
}

fn needs_accounts(detail: String) -> Result<(), String> {
    Err(format!("NEEDS TEST ACCOUNTS: {detail}"))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|_| "could not copy the TDLib directory".to_owned())?;
    for entry in
        std::fs::read_dir(from).map_err(|_| "could not read the TDLib directory".to_owned())?
    {
        let entry = entry.map_err(|_| "could not read the TDLib directory".to_owned())?;
        let kind = entry
            .file_type()
            .map_err(|_| "could not read the TDLib directory".to_owned())?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &dest)
                .map_err(|_| "could not copy the TDLib directory".to_owned())?;
        }
    }
    Ok(())
}

fn child_dirs(root: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in
        std::fs::read_dir(root).map_err(|_| "could not read the TDLib directory".to_owned())?
    {
        let entry = entry.map_err(|_| "could not read the TDLib directory".to_owned())?;
        if !entry
            .file_type()
            .map_err(|_| "could not read the TDLib directory".to_owned())?
            .is_dir()
        {
            continue;
        }
        if let Ok(name) = entry.file_name().into_string() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// Copy the saved desktop database and open the copy. TDLib writes while it
/// reads, and the saved account directories must stay untouched.
fn isolated_database(source: &Path) -> Result<(PathBuf, RemovedOnDrop), String> {
    let dest = std::env::temp_dir().join(format!("crm-chat-tdlib-accounts-{}", std::process::id()));
    if dest.starts_with(source) {
        return Err("refusing to open the saved TDLib directory".into());
    }
    let _ = std::fs::remove_dir_all(&dest);
    copy_tree(source, &dest)?;
    Ok((dest.clone(), RemovedOnDrop(dest)))
}

fn shape() -> Result<(), String> {
    let account = crm_chat_telegram::Account {
        id: "account-1".to_owned(),
        title: "Telegram account".to_owned(),
        chats: vec![
            crm_chat_telegram::Chat {
                id: "account-1:7".to_owned(),
                title: "Ada".to_owned(),
                kind: crm_chat_telegram::ChatKind::Dialog,
            },
            crm_chat_telegram::Chat {
                id: "account-1:8".to_owned(),
                title: "Team".to_owned(),
                kind: crm_chat_telegram::ChatKind::Group,
            },
            crm_chat_telegram::Chat {
                id: "account-1:9".to_owned(),
                title: "News".to_owned(),
                kind: crm_chat_telegram::ChatKind::Channel,
            },
        ],
    };
    crm_chat_telegram::require_desktop_authorized(&account)?;
    println!("authorized shape: pass");
    Ok(())
}

async fn accounts() -> Result<(), String> {
    let (api_id, api_hash) = credentials_from_env()?;
    let source = database_root();
    if !source.is_dir() {
        return needs_accounts(format!(
            "no TDLib directory at {}. Log in once in the desktop shell. The test reads a copy of that directory and does not read BWS session entries.",
            source.display()
        ));
    }
    let present = child_dirs(&source)?;
    if present.is_empty() {
        return needs_accounts(format!(
            "{} has no logged-in account. Log in once in the desktop shell. The test reads a copy of that directory and does not read BWS session entries.",
            source.display()
        ));
    }
    let (root, _copy) = isolated_database(&source)?;
    let client = Client::open(root)?;
    let saved = client.restore(api_id, &api_hash).await?;
    let restored = saved
        .iter()
        .map(|account| account.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let missing = present
        .iter()
        .filter(|id| !restored.contains(id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return needs_accounts(format!(
            "not logged in: {}. Log in once in the desktop shell. The test reads a copy of that directory and does not read BWS session entries.",
            missing.join(", ")
        ));
    }
    for account in &saved {
        crm_chat_telegram::require_desktop_authorized(account)?;
    }
    println!(
        "authenticated: pass (desktop tdlib, accounts={}, authorized)",
        saved.len()
    );
    Ok(())
}

async fn login(slot: &str) -> Result<(), String> {
    if slot != "1" && slot != "2" {
        return Err("usage: login <1|2>".into());
    }
    let (api_id, api_hash) = credentials_from_env()?;
    let root = database_root();
    let client = Client::open(root)?;
    let phone = prompt("Phone number with country code:", false)?;
    let mut step = client.begin_phone(slot, api_id, &api_hash, &phone).await?;
    loop {
        match step {
            AuthStep::Code { .. } => {
                let code = prompt("Code from Telegram:", true)?;
                step = client.submit_code(slot, &code).await?;
            }
            AuthStep::Password { .. } => {
                let password = prompt("Two-step verification password:", true)?;
                step = client.submit_password(slot, &password).await?;
            }
            AuthStep::Qr { .. } => return Err("QR login is not used by this command".into()),
            AuthStep::Authorized { .. } => {
                println!("login-test-account: saved account {slot}");
                return Ok(());
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let result = match command.as_str() {
        "shape" => shape(),
        "credentials" => credentials().await,
        "account" => accounts().await,
        "login" => login(&args.next().unwrap_or_default()).await,
        _ => Err("usage: shape | credentials | account | login <1|2>".into()),
    };
    if let Err(error) = result {
        if error.starts_with("NEEDS TEST ACCOUNTS:") {
            println!("{error}");
            std::process::exit(2);
        }
        eprintln!("desktop tdlib: {error}");
        std::process::exit(1);
    }
}
