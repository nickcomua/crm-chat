//! Telegram subscriber service for CRM Chat.
//!
//! This service subscribes to SpacetimeDB phone_auth and qr_auth events and
//! processes robot tasks for Telegram client authentication.

mod config;
mod error;
mod task;

use std::env;
use std::sync::Arc;

use config::{get_session_dir, TelegramConfig};
use sdb_api::module_bindings::{
    DbConnection, ErrorContext, PhoneAuth, PhoneAuthStep, PhoneAuthTableAccess, QrAuth, QrAuthStep,
    QrAuthTableAccess, SubscriptionEventContext,
};
use spacetimedb_sdk::{DbContext, Error, Table, TableWithPrimaryKey};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::task::{
    claim_phone_auth, claim_qr_auth, execute_phone_auth, execute_qr_auth, TaskExecutionContext,
};

/// Events from the phone_auth and qr_auth tables.
#[derive(Debug, Clone)]
pub enum AuthEvent {
    PhoneAuthInsert(PhoneAuth),
    PhoneAuthUpdate { old: PhoneAuth, new: PhoneAuth },
    QrAuthInsert(QrAuth),
    QrAuthUpdate { old: QrAuth, new: QrAuth },
}

fn on_sub_applied(ctx: &SubscriptionEventContext) {
    let phone_auths: Vec<_> = ctx.db.phone_auth().iter().collect();
    let qr_auths: Vec<_> = ctx.db.qr_auth().iter().collect();
    info!(
        phone_auth_count = phone_auths.len(),
        qr_auth_count = qr_auths.len(),
        "Subscription applied"
    );
    for auth in &phone_auths {
        debug!(
            auth_id = auth.id,
            step = ?auth.step,
            assigned_robot = ?auth.assigned_robot,
            "Found existing phone auth"
        );
    }
    for auth in &qr_auths {
        debug!(
            auth_id = auth.id,
            step = ?auth.step,
            assigned_robot = ?auth.assigned_robot,
            "Found existing QR auth"
        );
    }
}

fn on_sub_error(_ctx: &ErrorContext, err: Error) {
    error!(error = %err, "Subscription failed");
    std::process::exit(1);
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize Sentry (if SENTRY_URL is set)
    let _guard = env::var("SENTRY_URL").ok().map(|dsn| {
        sentry::init((
            dsn,
            sentry::ClientOptions {
                release: sentry::release_name!(),
                traces_sample_rate: 1.0,
                ..Default::default()
            },
        ))
    });

    // Initialize tracing with Sentry layer
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,telegram_subscriber=debug"));

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_tracing::layer());

    tracing::subscriber::set_global_default(subscriber)?;

    info!("Starting telegram-subscriber");

    if _guard.is_some() {
        info!("Sentry error tracking enabled");
    }

    let config = TelegramConfig::from_env()?;

    // Get robot identity from environment
    let my_identity: spacetimedb_sdk::Identity = env::var("DIRTY_IDENTITY")
        .expect("DIRTY_IDENTITY must be set")
        .parse()
        .expect("Invalid DIRTY_IDENTITY format");

    info!(identity = %my_identity, "Robot identity loaded from DIRTY_IDENTITY");

    let (tx, mut rx) = mpsc::unbounded_channel::<AuthEvent>();
    let token = env::var("DIRTY_TOKEN").expect("DIRTY_TOKEN must be set");
    let conn = DbConnection::builder()
        .with_module_name(
            env::var("VITE_SPACETIMEDB_MODULE").expect("VITE_SPACETIMEDB_MODULE must be set"),
        )
        .with_uri(env::var("VITE_SPACETIMEDB_HOST").expect("VITE_SPACETIMEDB_HOST must be set"))
        .with_token(Some(token))
        .build()
        .expect("Failed to connect");

    info!("Connected to SpacetimeDB");

    // Set up callbacks for phone_auth table events
    let tx_pa_insert = tx.clone();
    conn.db.phone_auth().on_insert(move |_ctx, row| {
        debug!(auth_id = row.id, step = ?row.step, "PhoneAuth inserted");
        if let Err(e) = tx_pa_insert.send(AuthEvent::PhoneAuthInsert(row.clone())) {
            error!(error = %e, "Failed to send phone auth insert event");
        }
    });

    let tx_pa_update = tx.clone();
    conn.db.phone_auth().on_update(move |_ctx, old, new| {
        debug!(auth_id = new.id, old_step = ?old.step, new_step = ?new.step, "PhoneAuth updated");
        if let Err(e) = tx_pa_update.send(AuthEvent::PhoneAuthUpdate {
            old: old.clone(),
            new: new.clone(),
        }) {
            error!(error = %e, "Failed to send phone auth update event");
        }
    });

    // Set up callbacks for qr_auth table events
    let tx_qr_insert = tx.clone();
    conn.db.qr_auth().on_insert(move |_ctx, row| {
        debug!(auth_id = row.id, step = ?row.step, "QrAuth inserted");
        if let Err(e) = tx_qr_insert.send(AuthEvent::QrAuthInsert(row.clone())) {
            error!(error = %e, "Failed to send QR auth insert event");
        }
    });

    let tx_qr_update = tx.clone();
    conn.db.qr_auth().on_update(move |_ctx, old, new| {
        debug!(auth_id = new.id, old_step = ?old.step, new_step = ?new.step, "QrAuth updated");
        if let Err(e) = tx_qr_update.send(AuthEvent::QrAuthUpdate {
            old: old.clone(),
            new: new.clone(),
        }) {
            error!(error = %e, "Failed to send QR auth update event");
        }
    });

    // Subscribe to auth tables
    conn.subscription_builder()
        .on_applied(on_sub_applied)
        .on_error(on_sub_error)
        .subscribe(["SELECT * FROM phone_auth", "SELECT * FROM qr_auth"]);

    info!(session_dir = ?get_session_dir(), "Session files stored in");

    // Create task execution context
    let conn_arc = Arc::new(conn);
    let ctx = TaskExecutionContext {
        conn: conn_arc.clone(),
        my_identity,
        config: config.clone(),
        sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
        qr_polling_tasks: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    // Spawn the SpacetimeDB connection runner
    let conn_for_run = conn_arc.clone();
    tokio::spawn(async move {
        if let Err(e) = conn_for_run.run_async().await {
            error!(error = %e, "Error in SpacetimeDB run_async");
        }
    });

    info!("Telegram subscriber started. Press Ctrl+C to exit.");

    // Main event loop
    loop {
        tokio::select! {
            Some(event) = rx.recv() => {
                process_auth_event(&ctx, event).await;
            }
            _ = tokio::signal::ctrl_c() => {
                info!("Shutting down...");
                break;
            }
        }
    }

    Ok(())
}

/// Process an auth event (insert or update on phone_auth/qr_auth tables).
async fn process_auth_event(ctx: &TaskExecutionContext, event: AuthEvent) {
    match event {
        AuthEvent::PhoneAuthInsert(auth) => {
            process_phone_auth(ctx, None, &auth).await;
        }
        AuthEvent::PhoneAuthUpdate { old, new } => {
            process_phone_auth(ctx, Some(&old), &new).await;
        }
        AuthEvent::QrAuthInsert(auth) => {
            process_qr_auth(ctx, None, &auth).await;
        }
        AuthEvent::QrAuthUpdate { old, new } => {
            process_qr_auth(ctx, Some(&old), &new).await;
        }
    }
}

/// Process a phone_auth row change.
///
/// For inserts (including initial subscription), `old` is None.
/// For updates, `old` is the previous state.
async fn process_phone_auth(ctx: &TaskExecutionContext, old: Option<&PhoneAuth>, new: &PhoneAuth) {
    let is_mine = new.assigned_robot.as_ref() == Some(&ctx.my_identity);

    // Unclaimed SendingCode → try to claim
    if new.step == PhoneAuthStep::SendingCode && new.assigned_robot.is_none() {
        debug!(auth_id = new.id, "Attempting to claim phone auth");
        if let Err(e) = claim_phone_auth(&ctx.conn, new.id) {
            warn!(auth_id = new.id, error = %e, "Failed to claim phone auth");
        }
        return;
    }

    // Only process further if assigned to us
    if !is_mine {
        return;
    }

    // Check if this event represents a state change we should act on
    let is_actionable = match old {
        None => true, // Insert (or initial subscription) → always process
        Some(old) => old.step != new.step || old.assigned_robot != new.assigned_robot,
    };

    if !is_actionable {
        return;
    }

    // Dispatch based on current step (only robot-actionable steps)
    match new.step {
        PhoneAuthStep::SendingCode
        | PhoneAuthStep::VerifyingCode
        | PhoneAuthStep::VerifyingPassword => {
            info!(auth_id = new.id, step = ?new.step, "Executing phone auth step");
            if let Err(e) = execute_phone_auth(ctx, new).await {
                error!(auth_id = new.id, error = %e, "Failed to execute phone auth step");
            }
        }
        _ => {
            // WaitingCode, WaitingPassword, Connected, Failed, Cancelled → no robot action
            debug!(auth_id = new.id, step = ?new.step, "No robot action for this step");
        }
    }
}

/// Process a qr_auth row change.
///
/// For inserts (including initial subscription), `old` is None.
/// For updates, `old` is the previous state.
async fn process_qr_auth(ctx: &TaskExecutionContext, old: Option<&QrAuth>, new: &QrAuth) {
    let is_mine = new.assigned_robot.as_ref() == Some(&ctx.my_identity);
    let is_terminal = matches!(
        new.step,
        QrAuthStep::Authorized
            | QrAuthStep::AlreadyAuthorized
            | QrAuthStep::Failed
            | QrAuthStep::Cancelled
    );

    // Cancel QR polling on terminal states
    if is_terminal {
        ctx.cancel_qr_polling(new.id).await;
        return;
    }

    // Unclaimed Pending → try to claim
    if new.step == QrAuthStep::Pending && new.assigned_robot.is_none() {
        debug!(auth_id = new.id, "Attempting to claim QR auth");
        if let Err(e) = claim_qr_auth(&ctx.conn, new.id) {
            warn!(auth_id = new.id, error = %e, "Failed to claim QR auth");
        }
        return;
    }

    if !is_mine {
        return;
    }

    let is_actionable = match old {
        None => true,
        Some(old) => old.step != new.step || old.assigned_robot != new.assigned_robot,
    };

    if !is_actionable {
        return;
    }

    match new.step {
        QrAuthStep::Generating => {
            info!(auth_id = new.id, "Executing QR auth");
            if let Err(e) = execute_qr_auth(ctx, new).await {
                error!(auth_id = new.id, error = %e, "Failed to execute QR auth");
            }
        }
        _ => {
            debug!(auth_id = new.id, step = ?new.step, "No robot action for this QR step");
        }
    }
}
