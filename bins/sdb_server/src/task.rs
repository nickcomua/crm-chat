//! Task management for background operations.
//!
//! Tasks are created by the frontend/API and picked up by robot workers (e.g., telegram-subscriber).
//! This enables async processing of authentication flows and other long-running operations.

use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

// Import table traits to access ctx.db.client(), ctx.db.robot(), etc.
use crate::client;
use crate::robot;

// === Task Status ===

/// Status of a task in the queue.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum TaskStatus {
    /// Task is waiting to be picked up by a robot.
    Unassigned,
    /// Task has been claimed by a robot and is being processed.
    Assigned(Identity),
    /// Task has completed (check result field for outcome).
    Done,
}

// === Task Payloads (Input + Output pairs) ===

// --- Generate QR Code ---

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct GenerateQrCodeResult {
    /// The QR URL (tg://login?token=...)
    pub url: String,
    /// Expiration timestamp (UTC ms since epoch)
    pub expires_at: u64,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum GenerateQrCodeOutput {
    Pending,
    Success(GenerateQrCodeResult),
    Failed(String),
}

/// Generate a QR code for Telegram login.
/// Input: nothing (client_id is in the task)
/// Output: QR URL and expiration, or error
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct GenerateQrCode {
    pub output: GenerateQrCodeOutput,
}

// --- Poll QR Login ---

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct PollQrLoginResult {
    /// Phone number of the logged-in account (if available).
    pub phone: Option<String>,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum PollQrLoginOutput {
    Pending,
    Success(PollQrLoginResult),
    PasswordRequired,
    Failed(String),
}

/// Poll for QR code scan completion.
/// Input: nothing (polls the existing QR session)
/// Output: still waiting, success with phone, password required, or error
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct PollQrLogin {
    pub output: PollQrLoginOutput,
}

// --- Request Login Code ---

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum RequestLoginCodeOutput {
    Pending,
    CodeSent,
    Failed(String),
}

/// Request a login code to be sent via SMS.
/// Input: phone number
/// Output: code sent confirmation, or error
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct RequestLoginCode {
    pub phone: String,
    pub output: RequestLoginCodeOutput,
}

// --- Verify Login Code ---

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyLoginCodeOutput {
    Pending,
    Success,
    PasswordRequired,
    Failed(String),
}

/// Verify the login code received via SMS.
/// Input: the code
/// Output: success, password required, or error
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyLoginCode {
    pub code: String,
    pub output: VerifyLoginCodeOutput,
}

// --- Verify Password ---

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyPasswordOutput {
    Pending,
    Success,
    Failed(String),
}

/// Verify the 2FA password.
/// Input: the password
/// Output: success, or error
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyPassword {
    pub password: String,
    pub output: VerifyPasswordOutput,
}

// === Unified Task Payload ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum TaskPayload {
    GenerateQrCode(GenerateQrCode),
    PollQrLogin(PollQrLogin),
    RequestLoginCode(RequestLoginCode),
    VerifyLoginCode(VerifyLoginCode),
    VerifyPassword(VerifyPassword),
}

// === Task Table ===

#[spacetimedb::table(name = task, public)]
#[derive(Debug)]
pub struct Task {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The user who owns this task (for authorization).
    #[index(btree)]
    pub owner_user_id: Identity,
    /// The client this task is associated with.
    #[index(btree)]
    pub client_id: u64,
    /// Current status of the task.
    #[index(btree)]
    pub status: TaskStatus,
    /// Task type with input and output bundled together.
    pub payload: TaskPayload,
    /// When the task was created.
    pub created_at: Timestamp,
    /// When the task was last updated.
    pub updated_at: Timestamp,
}

// === Task Reducers ===

/// Create a new task for a client.
/// Called by the frontend when user initiates an action (e.g., starts login).
#[reducer]
pub fn create_task(
    ctx: &ReducerContext,
    client_id: u64,
    payload: TaskPayload,
) -> Result<(), String> {
    // Verify the client exists and belongs to the sender
    let client = ctx
        .db
        .client()
        .id()
        .find(client_id)
        .ok_or("Client not found")?;

    let is_robot = ctx.db.robot().id().find(ctx.sender).is_some();
    if !is_robot && client.owner_user_id != ctx.sender {
        return Err("Unauthorized: cannot create task for another user's client".to_string());
    }

    let task = ctx.db.task().insert(Task {
        id: 0, // auto_inc
        owner_user_id: client.owner_user_id,
        client_id,
        status: TaskStatus::Unassigned,
        payload,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    log::info!(
        "Task created: id={}, client_id={}, payload={:?}",
        task.id,
        client_id,
        task.payload
    );

    Ok(())
}

/// Assign a task to a robot for processing.
/// Called by robots when they pick up a task from the queue.
#[reducer]
pub fn assign_task(ctx: &ReducerContext, task_id: u64) -> Result<(), String> {
    // Only robots can assign tasks
    if ctx.db.robot().id().find(ctx.sender).is_none() {
        return Err("Unauthorized: only robots can assign tasks".to_string());
    }

    let task = ctx
        .db
        .task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;

    // Can only assign unassigned tasks
    if !matches!(task.status, TaskStatus::Unassigned) {
        return Err("Task is not unassigned".to_string());
    }

    ctx.db.task().id().update(Task {
        status: TaskStatus::Assigned(ctx.sender),
        updated_at: ctx.timestamp,
        ..task
    });

    log::info!("Task assigned: id={}, robot={:?}", task_id, ctx.sender);

    Ok(())
}

/// Complete a task with an updated payload containing the output.
/// Called by robots when they finish processing a task.
#[reducer]
pub fn complete_task(
    ctx: &ReducerContext,
    task_id: u64,
    payload: TaskPayload,
) -> Result<(), String> {
    // Only robots can complete tasks
    if ctx.db.robot().id().find(ctx.sender).is_none() {
        return Err("Unauthorized: only robots can complete tasks".to_string());
    }

    let task = ctx
        .db
        .task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;

    // Verify this robot owns the task
    match &task.status {
        TaskStatus::Assigned(robot_id) if *robot_id == ctx.sender => {}
        _ => return Err("Task is not assigned to this robot".to_string()),
    }

    ctx.db.task().id().update(Task {
        status: TaskStatus::Done,
        payload,
        updated_at: ctx.timestamp,
        ..task
    });

    log::info!("Task completed: id={}, robot={:?}", task_id, ctx.sender);

    Ok(())
}

/// Delete a task (cleanup).
/// Can be called by the owner or a robot.
#[reducer]
pub fn delete_task(ctx: &ReducerContext, task_id: u64) -> Result<(), String> {
    let task = ctx
        .db
        .task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;

    let is_robot = ctx.db.robot().id().find(ctx.sender).is_some();
    if !is_robot && task.owner_user_id != ctx.sender {
        return Err("Unauthorized: cannot delete another user's task".to_string());
    }

    ctx.db.task().id().delete(task_id);

    log::info!("Task deleted: id={}", task_id);

    Ok(())
}
