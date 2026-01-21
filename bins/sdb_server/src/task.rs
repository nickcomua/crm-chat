//! Task management for background operations.
//!
//! Tasks are created by the frontend/API and picked up by robot workers (e.g., telegram-subscriber).
//! This enables async processing of authentication flows and other long-running operations.
//!
//! Each task payload mirrors the input/output of the corresponding TelegramClient method.

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

// --- Request Login Code ---
// TelegramClient::request_login_code(phone: &str) -> Result<ClonableLoginToken>

/// Mirrors ClonableLoginToken from messanger-telegram.
/// Contains the data needed to verify the login code.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct LoginToken {
    /// The phone number associated with this login attempt.
    pub phone: String,
    /// The hash received from Telegram for this login code request.
    pub phone_code_hash: String,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum RequestLoginCodeOutput {
    Pending,
    /// Login code sent successfully. Contains the token needed for sign_in.
    Success(LoginToken),
    /// Already authorized.
    AlreadyAuthorized,
    Failed(String),
}

/// Request a login code to be sent via SMS/Telegram.
/// Input: phone number in international format (e.g., "+1234567890")
/// Output: LoginToken containing phone and phone_code_hash
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct RequestLoginCode {
    pub phone: String,
    pub output: RequestLoginCodeOutput,
}

// --- Verify Login Code ---
// TelegramClient::sign_in(token: &ClonableLoginToken, code: &str) -> Result<SignInResult>

/// Mirrors ClonablePasswordToken from messanger-telegram.
/// Contains the data needed to verify the 2FA password.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct PasswordToken {
    /// Optional hint for the password.
    pub hint: Option<String>,
}

/// Success result containing user info.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct SignInSuccess {
    pub user_id: i64,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyLoginCodeOutput {
    Pending,
    /// Sign-in was successful.
    Success(SignInSuccess),
    /// 2FA password is required to complete sign-in.
    PasswordRequired(PasswordToken),
    /// The provided code was invalid.
    InvalidCode,
    /// Sign-up is required (account doesn't exist).
    SignUpRequired,
    Failed(String),
}

/// Verify the login code received via SMS/Telegram.
/// Input: the verification code (LoginToken is stored in robot's session)
/// Output: SignInSuccess, PasswordToken for 2FA, or error status
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyLoginCode {
    pub code: String,
    pub output: VerifyLoginCodeOutput,
}

// --- Verify Password ---
// TelegramClient::check_password(token: ClonablePasswordToken, password: &str) -> Result<CheckPasswordResult>

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyPasswordOutput {
    Pending,
    /// Password was correct, sign-in successful.
    Success(SignInSuccess),
    /// The provided password was invalid.
    InvalidPassword,
    Failed(String),
}

/// Verify the 2FA password.
/// Input: the password (PasswordToken is stored in robot's session)
/// Output: SignInSuccess or invalid password error
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyPassword {
    pub password: String,
    pub output: VerifyPasswordOutput,
}

// --- Generate QR Code ---
// TelegramClient::login_with_qr(api_id) -> Stream<QrLoginToken>

/// QR code token data for display.
/// Mirrors QrLoginToken::Token from messanger-telegram.
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct QrToken {
    /// The `tg://login?token=...` URL that should be displayed as a QR code.
    pub url: String,
    /// Unix timestamp when this token expires.
    pub expires: i32,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum GenerateQrCodeOutput {
    Pending,
    /// QR code generated successfully.
    Token(QrToken),
    /// Already authorized.
    AlreadyAuthorized,
    Failed(String),
}

/// Generate a QR code for Telegram login.
/// Input: nothing (client_id is in the task)
/// Output: QrToken with URL and expiration
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct GenerateQrCode {
    pub output: GenerateQrCodeOutput,
}

// --- Poll QR Login ---
// Continues polling TelegramClient::login_with_qr stream

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum PollQrLoginOutput {
    Pending,
    /// New QR token URL to display (token expired and was refreshed).
    Token(QrToken),
    /// QR scanned and login succeeded.
    Success,
    /// QR scanned but 2FA password is required.
    PasswordRequired(PasswordToken),
    Failed(String),
}

/// Poll for QR code scan completion.
/// Input: nothing (polls the existing QR session)
/// Output: new QrToken, success, PasswordToken for 2FA, or error
#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct PollQrLogin {
    pub output: PollQrLoginOutput,
}

// === Unified Task Payload ===

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum TaskPayload {
    RequestLoginCode(RequestLoginCode),
    VerifyLoginCode(VerifyLoginCode),
    VerifyPassword(VerifyPassword),
    GenerateQrCode(GenerateQrCode),
    PollQrLogin(PollQrLogin),
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
