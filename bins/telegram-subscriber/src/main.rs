//! Telegram subscriber service for CRM Chat.
//!
//! This service subscribes to SpacetimeDB task events and processes robot tasks
//! for Telegram client authentication.

mod config;
mod error;
mod task;

use std::env;
use std::sync::Arc;

use config::{get_session_dir, TelegramConfig};
use sdb_api::module_bindings::{
    DbConnection, ErrorContext, SubscriptionEventContext, Task, TaskTableAccess,
};
use spacetimedb_sdk::{DbContext, Error, Table, TableWithPrimaryKey};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::task::{execute_task, is_robot_task, pick_task, TaskExecutionContext};

/// Events from the task table.
#[derive(Debug, Clone)]
pub enum TaskEvent {
    Insert(Task),
    Update { old: Task, new: Task },
}

impl TaskEvent {
    pub fn task(&self) -> &Task {
        match self {
            TaskEvent::Insert(t) => t,
            TaskEvent::Update { new, .. } => new,
        }
    }
}

fn on_sub_applied(ctx: &SubscriptionEventContext) {
    let tasks: Vec<_> = ctx.db.task().iter().collect();
    info!(task_count = tasks.len(), "Subscription applied");
    for task in &tasks {
        debug!(
            task_id = %task.id,
            status = ?task.status,
            payload_type = ?std::mem::discriminant(&task.payload),
            "Found existing task"
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

    let (tx, mut rx) = mpsc::unbounded_channel::<TaskEvent>();
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

    // Set up callbacks for task table events
    let tx_insert = tx.clone();
    conn.db.task().on_insert(move |_ctx, row| {
        debug!(task_id = %row.id, "Task inserted");
        if let Err(e) = tx_insert.send(TaskEvent::Insert(row.clone())) {
            error!(error = %e, "Failed to send task insert event");
        }
    });

    let tx_update = tx.clone();
    conn.db.task().on_update(move |_ctx, old, new| {
        debug!(task_id = %new.id, old_status = ?old.status, new_status = ?new.status, "Task updated");
        if let Err(e) = tx_update.send(TaskEvent::Update {
            old: old.clone(),
            new: new.clone(),
        }) {
            error!(error = %e, "Failed to send task update event");
        }
    });

    // Subscribe to tasks
    conn.subscription_builder()
        .on_applied(on_sub_applied)
        .on_error(on_sub_error)
        .subscribe(["SELECT * FROM task"]);

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
                process_task_event(&ctx, event).await;
            }
            _ = tokio::signal::ctrl_c() => {
                info!("Shutting down...");
                break;
            }
        }
    }

    Ok(())
}

/// Process a task event (insert or update).
async fn process_task_event(ctx: &TaskExecutionContext, event: TaskEvent) {
    let task = event.task();

    // Skip non-robot tasks entirely
    if !is_robot_task(&task.payload) {
        return;
    }

    match &task.status {
        sdb_api::module_bindings::TaskStatus::Unassigned => {
            // Try to pick (assign) the task
            debug!(task_id = %task.id, "Attempting to pick unassigned task");
            match pick_task(&ctx.conn, task, ctx.my_identity) {
                Ok(true) => {
                    info!(task_id = %task.id, "Successfully picked task");
                    // Don't execute yet - wait for the update event with Assigned status
                }
                Ok(false) => {
                    debug!(
                        task_id = %task.id,
                        "Task not picked (already assigned or not a robot task)"
                    );
                }
                Err(e) => {
                    warn!(task_id = %task.id, error = %e, "Failed to pick task");
                }
            }
        }
        sdb_api::module_bindings::TaskStatus::Assigned(robot_id)
            if *robot_id == ctx.my_identity =>
        {
            // Only execute if this is a fresh assignment (transition from Unassigned)
            // Skip if this is just an update to an already-assigned task (e.g., QR token update)
            let should_execute = match &event {
                TaskEvent::Insert(_) => true,
                TaskEvent::Update { old, .. } => {
                    matches!(old.status, sdb_api::module_bindings::TaskStatus::Unassigned)
                }
            };

            if should_execute {
                info!(task_id = %task.id, "Executing newly assigned task");
                if let Err(e) = execute_task(ctx, task).await {
                    error!(task_id = %task.id, error = %e, "Failed to execute task");
                }
            } else {
                debug!(task_id = %task.id, "Skipping execution - task already being processed");
            }
        }
        sdb_api::module_bindings::TaskStatus::Assigned(_) => {
            // Task is assigned to another robot - ignore
            debug!(task_id = %task.id, "Task assigned to another robot, ignoring");
        }
        sdb_api::module_bindings::TaskStatus::Done => {
            // Task is done - cancel any active QR polling for this task
            debug!(task_id = %task.id, "Task is done");

            // Check if this task has an active QR polling loop and cancel it
            let mut polling_tasks = ctx.qr_polling_tasks.lock().await;
            if let Some(handle) = polling_tasks.remove(&task.id) {
                info!(task_id = %task.id, "Cancelling QR polling for completed/cancelled task");
                handle.cancel.cancel();
            }
        }
    }
}
