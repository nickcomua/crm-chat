//! Telegram subscriber service for CRM Chat.
//!
//! This service subscribes to SpacetimeDB client events and manages Telegram
//! client authentication. Once authenticated, clients can be used to read and
//! write messages via the messanger-telegram library.

mod auth;
mod config;
mod db;
mod session;

use anyhow::Result;
use config::{TelegramConfig, get_session_dir};
use db::{ClientEvent, process_client};
use sdb_api::module_bindings::{
    ClientTableAccess, DbConnection, ErrorContext, SubscriptionEventContext,
};
use session::new_active_sessions;
use spacetimedb_sdk::{DbContext, Error, Table, TableWithPrimaryKey};
use std::env;
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
    let sessions = new_active_sessions();
    let (tx, mut rx) = mpsc::unbounded_channel::<ClientEvent>();

    let conn = DbConnection::builder()
        .with_module_name(
            env::var("VITE_SPACETIMEDB_MODULE").expect("VITE_SPACETIMEDB_MODULE must be set"),
        )
        .with_uri(env::var("VITE_SPACETIMEDB_HOST").expect("VITE_SPACETIMEDB_HOST must be set"))
        .with_token(Some(
            env::var("DIRTY_TOKEN").expect("DIRTY_TOKEN must be set"),
        ))
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
        .subscribe(["SELECT * FROM client", "SELECT * FROM user"]);

    conn.run_threaded();

    println!("Telegram subscriber started. Press Ctrl+C to exit.");
    println!("Session files stored in: {:?}", get_session_dir());

    // Process events in the main async loop
    loop {
        tokio::select! {
            Some(event) = rx.recv() => {
                process_client(&conn, event.client(), sessions.clone(), &config).await;
            }
            _ = tokio::signal::ctrl_c() => {
                println!("Shutting down...");
                break;
            }
        }
    }

    Ok(())
}
