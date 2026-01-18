//! Telegram subscriber service for CRM Chat.
//!
//! This service subscribes to SpacetimeDB client events and manages Telegram
//! client authentication. Once authenticated, clients can be used to read and
//! write messages via the messanger-telegram library.

mod auth;
mod config;
mod db;
mod ids;
mod session;
mod subscriber;

use anyhow::Result;
use config::{TelegramConfig, get_session_dir};
use db::{ClientEvent, process_client};
use sdb_api::module_bindings::{
    ClientTableAccess, DbConnection, ErrorContext, SubscriptionEventContext,
};
use spacetimedb_sdk::{DbContext, Error, Table, TableWithPrimaryKey};
use std::env;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;
use tokio::sync::mpsc;

fn on_sub_applied(ctx: &SubscriptionEventContext) {
    let clients: Vec<_> = ctx.db.client().iter().collect();
    println!("Subscription applied. Found {} clients.", clients.len());
    for client in &clients {
        println!("  Client {}: {:?}", client.id, client.status);
    }
}

fn on_sub_error(_ctx: &ErrorContext, err: Error) {
    eprintln!("Subscription failed: {}", err);
    std::process::exit(1);
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = TelegramConfig::from_env()?;
    let (tx, mut rx) = mpsc::unbounded_channel::<ClientEvent>();
    let token = env::var("DIRTY_TOKEN").expect("DIRTY_TOKEN must be set");
    let conn = DbConnection::builder()
        .with_module_name(
            env::var("VITE_SPACETIMEDB_MODULE").expect("VITE_SPACETIMEDB_MODULE must be set"),
        )
        .with_uri(env::var("VITE_SPACETIMEDB_HOST").expect("VITE_SPACETIMEDB_HOST must be set"))
        .with_token(Some(token))
        .build()
        .expect("Failed to connect");

    // Set up callbacks that send events to the channel
    let tx_insert = tx.clone();
    conn.db.client().on_insert(move |_ctx, row| {
        if let Err(e) = tx_insert.send(ClientEvent::Insert(row.clone())) {
            eprintln!("Failed to send insert event: {}", e);
        }
    });

    let tx_update = tx.clone();
    conn.db.client().on_update(move |_ctx, old, new| {
        if let Err(e) = tx_update.send(ClientEvent::Update {
            _old: old.clone(),
            new: new.clone(),
        }) {
            eprintln!("Failed to send update event: {}", e);
        }
    });

    conn.subscription_builder()
        .on_applied(on_sub_applied)
        .on_error(on_sub_error)
        .subscribe([
            // format!("SELECT u.* FROM user u WHERE u.id = '0x{identity}'"),
            // format!("SELECT * FROM client WHERE owner_user_id = '0x{identity}'"),
            // "SELECT * FROM chat".to_string(),
            "SELECT * FROM user",
            "SELECT * FROM client",
            "SELECT * FROM chat",
        ]);

    println!("Telegram subscriber started. Press Ctrl+C to exit.");
    println!("Session files stored in: {:?}", get_session_dir());

    // Process events in the main async loop
    let sessions = Arc::new(Mutex::new(HashMap::new()));
    let conn_ark = Arc::new(conn);
    let conn_ark_for_run = conn_ark.clone();
    _ = tokio::spawn(async move {
        if let Err(e) = conn_ark_for_run.run_async().await {
            eprintln!("Error in run_async: {}", e);
        }
    });
    loop {
        tokio::select! {
            Some(event) = rx.recv() => {
                process_client(conn_ark.clone(), event.client(), sessions.clone(), &config).await;
            }
            _ = tokio::signal::ctrl_c() => {
                println!("Shutting down...");
                break;
            }
        }
    }

    Ok(())
}
