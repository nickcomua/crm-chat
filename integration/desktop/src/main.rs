//! Desktop-path Telegram check and one-time login through TDLib.
//!
//! `account` follows the Tauri commands `telegram_restore`,
//! `telegram_begin_login`, and `telegram_load_account`: it opens a copy of the
//! saved desktop database, restores each logged-in account, reads that chat
//! list, then starts a QR login and approves it from one saved account.
//! Prints pass lines and TDLib error codes only. Never print secrets,
//! database contents, phone numbers, login links, or user ids.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use crm_chat_telegram::{database_root, AuthStep, Client};

const LOGIN_PROBE: &str = "login-probe";

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

fn lexical_normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// True when either path is the other, or one lies inside the other.
/// `Path::starts_with` alone misses a destination that normalizes back into
/// the saved tree (`tdlib/../tdlib/copy`) and a saved tree that sits inside
/// the directory `remove_dir_all` would delete.
fn copies_into_saved_tree(source: &Path, dest: &Path) -> bool {
    let source = lexical_normal(source);
    let dest = lexical_normal(dest);
    source == dest || dest.starts_with(&source) || source.starts_with(&dest)
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
    if copies_into_saved_tree(source, &dest) {
        return Err("refusing to open the saved TDLib directory".into());
    }
    let _ = std::fs::remove_dir_all(&dest);
    let guard = RemovedOnDrop(dest.clone());
    copy_tree(source, &guard.0)?;
    Ok((dest, guard))
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

fn require_listed_chats(account: &crm_chat_telegram::Account) -> Result<(), String> {
    if account.chats.is_empty() {
        return Err("chat list is empty".into());
    }
    crm_chat_telegram::require_desktop_authorized(account)
}

async fn await_chat_list(
    client: &Client,
    mut account: crm_chat_telegram::Account,
) -> Result<crm_chat_telegram::Account, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if !account.chats.is_empty() {
            require_listed_chats(&account)?;
            return Ok(account);
        }
        if std::time::Instant::now() >= deadline {
            return Err("chat list is empty".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        account = client.load_account(&account.id).await?;
    }
}

async fn qr_login(
    client: &Client,
    approver: &str,
    api_id: i32,
    api_hash: &str,
) -> Result<crm_chat_telegram::Account, String> {
    if approver == LOGIN_PROBE {
        return Err("saved account uses the login probe id".into());
    }
    let started = client.begin_qr(LOGIN_PROBE, api_id, api_hash).await?;
    let link = match started {
        AuthStep::Qr { link, .. } => link,
        AuthStep::Authorized { account } => return await_chat_list(client, account).await,
        AuthStep::Password { .. } => {
            return Err("test account is waiting for a 2FA password and none is stored".into());
        }
        AuthStep::Code { .. } => {
            return Err("Telegram asked for a phone code during a QR login".into());
        }
    };
    let confirmed = client.confirm_qr(approver, &link).await;
    drop(link);
    confirmed?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
    loop {
        match client.poll(LOGIN_PROBE).await {
            Ok(AuthStep::Authorized { account }) => return await_chat_list(client, account).await,
            Ok(AuthStep::Password { .. }) => {
                return Err("test account is waiting for a 2FA password and none is stored".into());
            }
            Ok(AuthStep::Code { .. }) => {
                return Err("Telegram asked for a phone code during a QR login".into());
            }
            Ok(AuthStep::Qr { .. }) => {}
            Err(error)
                if error == "Telegram is still starting"
                    || error == "Telegram did not answer in time" => {}
            Err(error) => return Err(error),
        }
        if std::time::Instant::now() >= deadline {
            return Err("Telegram did not finish QR login in time".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
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
    let mut listed = Vec::new();
    for account in saved {
        listed.push(await_chat_list(&client, account).await?);
    }
    let Some(approver) = listed.first() else {
        return Err("no saved account can approve QR login".into());
    };
    let approver_id = approver.id.clone();
    let chat_count: usize = listed.iter().map(|account| account.chats.len()).sum();
    println!(
        "authenticated: pass (desktop tdlib, accounts={}, authorized)",
        listed.len()
    );
    println!(
        "chat-list: pass (desktop tdlib, accounts={}, chats={})",
        listed.len(),
        chat_count
    );
    let logged_in = qr_login(&client, &approver_id, api_id, &api_hash).await;
    let logged_out = client.logout(LOGIN_PROBE).await;
    let logged_in = logged_in?;
    logged_out?;
    println!(
        "login: pass (desktop tdlib, qr, chats={})",
        logged_in.chats.len()
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

#[cfg(test)]
mod tests {
    use super::{copies_into_saved_tree, isolated_database, require_listed_chats};
    use std::path::Path;

    #[test]
    fn a_destination_that_normalizes_into_the_saved_tree_is_refused() {
        let source = Path::new("/data/tdlib");
        let dest = Path::new("/data/tdlib/../tdlib/copy");
        assert!(copies_into_saved_tree(source, dest));
        assert!(copies_into_saved_tree(source, source));
    }

    #[test]
    fn a_saved_tree_inside_the_destination_is_refused() {
        let dest = Path::new("/tmp/crm-chat-tdlib-accounts-7");
        let source = Path::new("/tmp/crm-chat-tdlib-accounts-7/saved");
        assert!(copies_into_saved_tree(source, dest));
    }

    #[test]
    fn a_temp_copy_outside_the_saved_tree_is_allowed() {
        let source = Path::new("/home/me/.local/share/app.crmchat.desktop/tdlib");
        let dest = Path::new("/tmp/crm-chat-tdlib-accounts-7");
        assert!(!copies_into_saved_tree(source, dest));
        assert!(!copies_into_saved_tree(
            Path::new("/tmp/crm-chat-tdlib-accounts-7"),
            Path::new("/tmp/crm-chat-tdlib-accounts-70"),
        ));
    }

    #[test]
    fn the_cleanup_guard_removes_a_partial_copy() {
        let root = std::env::temp_dir().join(format!(
            "crm-chat-iso-src-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("acct")).expect("source");
        std::fs::write(root.join("acct").join("db"), b"x").expect("db");
        let (dest, guard) = isolated_database(&root).expect("copy");
        assert!(dest.join("acct").join("db").is_file());
        assert!(root.join("acct").join("db").is_file());
        assert_ne!(dest, root);
        drop(guard);
        assert!(!dest.exists());
        assert!(root.join("acct").join("db").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_chat_list_is_not_a_logged_in_desktop_account() {
        let account = crm_chat_telegram::Account {
            id: "account-1".to_owned(),
            title: "Ada".to_owned(),
            chats: Vec::new(),
        };
        assert_eq!(
            require_listed_chats(&account).expect_err("empty list"),
            "chat list is empty"
        );
    }

    #[test]
    fn a_restored_chat_list_matches_the_desktop_authorized_shape() {
        let account = crm_chat_telegram::Account {
            id: "account-1".to_owned(),
            title: "Ada".to_owned(),
            chats: vec![crm_chat_telegram::Chat {
                id: "account-1:7".to_owned(),
                title: "Ada".to_owned(),
                kind: crm_chat_telegram::ChatKind::Dialog,
            }],
        };
        require_listed_chats(&account).expect("chat list");
    }
}
