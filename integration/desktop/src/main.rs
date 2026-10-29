//! Desktop-path Telegram check and one-time login through TDLib.
//!
//! Prints pass lines and TDLib error codes only. Never print secrets,
//! database contents, phone numbers, login links, or user ids.

use std::io::{BufRead, Write};

use crm_chat_telegram::{AuthStep, Client, database_root};

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

async fn accounts() -> Result<(), String> {
    let (api_id, api_hash) = credentials_from_env()?;
    let root = database_root();
    if !root.is_dir() {
        println!(
            "NEEDS TEST ACCOUNTS: no TDLib directory at {}. Log in once in the desktop shell. The test reads that directory and does not read BWS session entries.",
            root.display()
        );
        std::process::exit(2);
    }
    let client = Client::open(root.clone())?;
    let saved = client.restore(api_id, &api_hash).await?;
    if saved.is_empty() {
        println!(
            "NEEDS TEST ACCOUNTS: {} has no logged-in account. Log in once in the desktop shell. The test reads that directory and does not read BWS session entries.",
            root.display()
        );
        std::process::exit(2);
    }
    println!(
        "authenticated: pass (desktop tdlib, accounts={})",
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
        "credentials" => credentials().await,
        "account" => accounts().await,
        "login" => login(&args.next().unwrap_or_default()).await,
        _ => Err("usage: credentials | account | login <1|2>".into()),
    };
    if let Err(error) = result {
        eprintln!("desktop tdlib: {error}");
        std::process::exit(1);
    }
}
