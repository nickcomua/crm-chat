use spacetimedb::rand::RngCore;
use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};
use uuid::Uuid;

use crate::client::client;
use crate::robot::robot;
use crate::{Client, ClientStatus};

// Sub-modules
pub mod auth;
pub mod display_message;
pub mod shared;

// Re-exports for convenience
pub use auth::*;
pub use display_message::{DisplayMessage, DisplayMessageOutput, MessageSeverity};
pub use shared::{LoginToken, PasswordToken, QrToken, SignInSuccess};

pub type TaskId = String;

/// Helper to generate a new task ID
pub(crate) fn new_task_id(ctx: &ReducerContext) -> TaskId {
    let mut random_bytes = [0u8; 16];
    ctx.rng().try_fill_bytes(&mut random_bytes).unwrap();
    Uuid::from_bytes(random_bytes).to_string()
}

/// Who should process this task
#[derive(Clone, Debug)]
pub enum TaskType {
    /// Task for human interaction (e.g., entering code/password, dismissing messages)
    Human,
    /// Task for robot/worker processing (e.g., sending SMS, verifying code)
    Robot,
}

/// Trait for task payloads that defines their lifecycle
trait Taskable {
    /// Validate the task payload before creation
    fn validate(&self) -> Result<(), String>;

    /// Check if the task has reached a terminal state
    fn is_done(&self) -> bool;

    /// Called when task is created - can spawn side effects like creating client
    fn on_create(_task: &Task, _ctx: &ReducerContext) -> Result<(), String>
    where
        Self: Sized,
    {
        Ok(())
    }

    /// Called when task is completed - can spawn next tasks, update client status
    fn on_done(_task: &Task, _ctx: &ReducerContext) -> Result<(), String>
    where
        Self: Sized,
    {
        Ok(())
    }

    /// What type of entity should process this task
    fn task_type(&self) -> TaskType;
}

// =============================================================================
// Task Status
// =============================================================================

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum TaskStatus {
    Unassigned,
    Assigned(Identity),
    Done,
}

/// Helper to send an error message to the user
pub(crate) fn send_error(ctx: &ReducerContext, owner_user_id: Identity, error: String) {
    ctx.db.task().insert(Task {
        id: new_task_id(ctx),
        owner_user_id,
        payload: TaskPayload::DisplayMessage(DisplayMessage {
            severity: MessageSeverity::Error,
            message: error,
            output: DisplayMessageOutput::Pending,
        }),
        status: TaskStatus::Unassigned,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Get a client by user ID and phone number
pub(crate) fn get_one_client(ctx: &ReducerContext, user_id: &Identity, client_phone: &str) -> Option<Client> {
    ctx.db
        .client()
        .user_client_pair()
        .filter((user_id, &client_phone.to_string()))
        .next()
}

/// Update client status helper
pub(crate) fn update_client_status(
    ctx: &ReducerContext,
    user_id: &Identity,
    client_phone: &str,
    new_status: ClientStatus,
) -> Result<(), String> {
    let client =
        get_one_client(ctx, user_id, client_phone).ok_or("Client not found".to_string())?;
    ctx.db.client().id().update(Client {
        status: new_status,
        ..client
    });
    Ok(())
}

/// Delete client helper
pub(crate) fn delete_client(ctx: &ReducerContext, user_id: &Identity, client_phone: &str) {
    if let Some(client) = get_one_client(ctx, user_id, client_phone) {
        ctx.db.client().id().delete(client.id);
    }
}

// =============================================================================
// Task Payload Enum
// =============================================================================

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum TaskPayload {
    // Phone login flow
    SendLoginCode(SendLoginCode),
    ReceiveLoginCode(ReceiveLoginCode),
    VerifyLoginCode(VerifyLoginCode),
    ReceivePassword(ReceivePassword),
    VerifyPassword(VerifyPassword),

    // QR code login flow
    GenerateQrCode(GenerateQrCode),

    // User notifications
    DisplayMessage(DisplayMessage),
}

impl Taskable for TaskPayload {
    fn validate(&self) -> Result<(), String> {
        match self {
            TaskPayload::SendLoginCode(p) => p.validate(),
            TaskPayload::ReceiveLoginCode(p) => p.validate(),
            TaskPayload::VerifyLoginCode(p) => p.validate(),
            TaskPayload::ReceivePassword(p) => p.validate(),
            TaskPayload::VerifyPassword(p) => p.validate(),
            TaskPayload::GenerateQrCode(p) => p.validate(),
            TaskPayload::DisplayMessage(p) => p.validate(),
        }
    }

    fn is_done(&self) -> bool {
        match self {
            TaskPayload::SendLoginCode(p) => p.is_done(),
            TaskPayload::ReceiveLoginCode(p) => p.is_done(),
            TaskPayload::VerifyLoginCode(p) => p.is_done(),
            TaskPayload::ReceivePassword(p) => p.is_done(),
            TaskPayload::VerifyPassword(p) => p.is_done(),
            TaskPayload::GenerateQrCode(p) => p.is_done(),
            TaskPayload::DisplayMessage(p) => p.is_done(),
        }
    }

    fn on_create(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        match &task.payload {
            TaskPayload::SendLoginCode(_) => SendLoginCode::on_create(task, ctx),
            TaskPayload::ReceiveLoginCode(_) => ReceiveLoginCode::on_create(task, ctx),
            TaskPayload::VerifyLoginCode(_) => VerifyLoginCode::on_create(task, ctx),
            TaskPayload::ReceivePassword(_) => ReceivePassword::on_create(task, ctx),
            TaskPayload::VerifyPassword(_) => VerifyPassword::on_create(task, ctx),
            TaskPayload::GenerateQrCode(_) => GenerateQrCode::on_create(task, ctx),
            TaskPayload::DisplayMessage(_) => DisplayMessage::on_create(task, ctx),
        }
    }

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        match &task.payload {
            TaskPayload::SendLoginCode(_) => SendLoginCode::on_done(task, ctx),
            TaskPayload::ReceiveLoginCode(_) => ReceiveLoginCode::on_done(task, ctx),
            TaskPayload::VerifyLoginCode(_) => VerifyLoginCode::on_done(task, ctx),
            TaskPayload::ReceivePassword(_) => ReceivePassword::on_done(task, ctx),
            TaskPayload::VerifyPassword(_) => VerifyPassword::on_done(task, ctx),
            TaskPayload::GenerateQrCode(_) => GenerateQrCode::on_done(task, ctx),
            TaskPayload::DisplayMessage(_) => DisplayMessage::on_done(task, ctx),
        }
    }

    fn task_type(&self) -> TaskType {
        match self {
            TaskPayload::SendLoginCode(p) => p.task_type(),
            TaskPayload::ReceiveLoginCode(p) => p.task_type(),
            TaskPayload::VerifyLoginCode(p) => p.task_type(),
            TaskPayload::ReceivePassword(p) => p.task_type(),
            TaskPayload::VerifyPassword(p) => p.task_type(),
            TaskPayload::GenerateQrCode(p) => p.task_type(),
            TaskPayload::DisplayMessage(p) => p.task_type(),
        }
    }
}

// =============================================================================
// Task Table
// =============================================================================

#[spacetimedb::table(name = task, public)]
#[derive(Debug, Clone)]
pub struct Task {
    #[primary_key]
    pub id: TaskId,
    #[index(btree)]
    pub owner_user_id: Identity,
    #[index(btree)]
    pub status: TaskStatus,
    pub payload: TaskPayload,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

// =============================================================================
// Reducers
// =============================================================================

#[reducer]
pub fn create_task(ctx: &ReducerContext, id: TaskId, payload: TaskPayload) -> Result<(), String> {
    payload.validate()?;

    let task = Task {
        id,
        owner_user_id: ctx.sender,
        status: TaskStatus::Unassigned,
        payload,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    };

    // Run on_create hook before inserting
    TaskPayload::on_create(&task, ctx)?;

    ctx.db.task().insert(task.clone());

    log::info!(
        "Task created: id={}, owner_user_id={}, payload={:?}",
        task.id,
        task.owner_user_id,
        task.payload
    );

    Ok(())
}

#[reducer]
pub fn assign_task(ctx: &ReducerContext, task_id: TaskId) -> Result<(), String> {
    if ctx.db.robot().id().find(ctx.sender).is_none() {
        return Err("Unauthorized: only robots can assign tasks".to_string());
    }

    let task = ctx.db.task().id().find(&task_id).ok_or("Task not found")?;

    if !matches!(task.status, TaskStatus::Unassigned) {
        return Err("Task is not unassigned".to_string());
    }

    let updated_task = Task {
        status: TaskStatus::Assigned(ctx.sender),
        updated_at: ctx.timestamp,
        ..task
    };

    ctx.db.task().id().update(updated_task);

    log::info!("Task assigned: id={}, robot={:?}", task_id, ctx.sender);

    Ok(())
}

#[reducer]
pub fn complete_task(
    ctx: &ReducerContext,
    task_id: TaskId,
    payload: TaskPayload,
) -> Result<(), String> {
    if !payload.is_done() {
        return Err("Task is not done".to_string());
    }

    let task = ctx
        .db
        .task()
        .id()
        .find(task_id.clone())
        .ok_or("Task not found")?;

    let is_robot = ctx.db.robot().id().find(ctx.sender).is_some();
    let is_owner = task.owner_user_id == ctx.sender;

    // Check authorization based on task type
    match payload.task_type() {
        TaskType::Robot => {
            // Robot tasks can only be completed by the assigned robot
            if !is_robot {
                return Err("Unauthorized: only robots can complete robot tasks".to_string());
            }
            match &task.status {
                TaskStatus::Assigned(robot_id) if *robot_id == ctx.sender => {}
                _ => return Err("Task is not assigned to this robot".to_string()),
            }
        }
        TaskType::Human => {
            // User tasks can only be completed by the owner
            if !is_owner {
                return Err("Unauthorized: only the task owner can complete user tasks".to_string());
            }
        }
    }

    // Update task with completed payload before calling on_done
    let completed_task = Task {
        status: TaskStatus::Done,
        payload,
        updated_at: ctx.timestamp,
        ..task
    };

    // Update the task first so on_done sees the completed state
    ctx.db.task().id().update(completed_task.clone());

    // Run on_done hook - this may delete the task and spawn new ones
    TaskPayload::on_done(&completed_task, ctx)?;

    log::info!("Task completed: id={}, sender={:?}", task_id, ctx.sender);

    Ok(())
}

/// Reducer for robots to update task payload without completing it (e.g., QR token updates)
#[reducer]
pub fn update_task(
    ctx: &ReducerContext,
    task_id: String,
    payload: TaskPayload,
) -> Result<(), String> {
    if ctx.db.robot().id().find(ctx.sender).is_none() {
        return Err("Unauthorized: only robots can update tasks".to_string());
    }

    let task = ctx
        .db
        .task()
        .id()
        .find(task_id.clone())
        .ok_or("Task not found")?;

    match &task.status {
        TaskStatus::Assigned(robot_id) if *robot_id == ctx.sender => {}
        _ => return Err("Task is not assigned to this robot".to_string()),
    }

    // Don't allow completing via update_task - use complete_task for that
    if payload.is_done() {
        return Err("Cannot complete task via update_task, use complete_task instead".to_string());
    }

    ctx.db.task().id().update(Task {
        payload,
        updated_at: ctx.timestamp,
        ..task
    });

    log::info!("Task updated: id={}, robot={:?}", task_id, ctx.sender);

    Ok(())
}

/// Reducer for users to cancel their own tasks (e.g., aborting QR login)
#[reducer]
pub fn cancel_task(ctx: &ReducerContext, task_id: TaskId) -> Result<(), String> {
    let task = ctx
        .db
        .task()
        .id()
        .find(task_id.clone())
        .ok_or("Task not found")?;

    // Only the task owner can cancel their tasks
    if task.owner_user_id != ctx.sender {
        return Err("Unauthorized: only the task owner can cancel tasks".to_string());
    }

    // Can only cancel non-completed tasks
    if matches!(task.status, TaskStatus::Done) {
        return Err("Cannot cancel a completed task".to_string());
    }

    // Create the cancelled payload based on task type
    let cancelled_payload = match &task.payload {
        TaskPayload::GenerateQrCode(_) => TaskPayload::GenerateQrCode(GenerateQrCode {
            output: GenerateQrCodeOutput::Cancelled,
        }),
        TaskPayload::ReceiveLoginCode(p) => TaskPayload::ReceiveLoginCode(ReceiveLoginCode {
            client_phone: p.client_phone.clone(),
            token: p.token.clone(),
            output: ReceiveLoginCodeOutput::Aborted,
        }),
        TaskPayload::ReceivePassword(p) => TaskPayload::ReceivePassword(ReceivePassword {
            client_phone: p.client_phone.clone(),
            hint: p.hint.clone(),
            token: p.token.clone(),
            output: ReceivePasswordOutput::Aborted,
        }),
        // Robot tasks and DisplayMessage cannot be cancelled by user this way
        _ => return Err("This task type cannot be cancelled".to_string()),
    };

    // Update task with cancelled payload and mark as done
    let cancelled_task = Task {
        status: TaskStatus::Done,
        payload: cancelled_payload,
        updated_at: ctx.timestamp,
        ..task
    };

    ctx.db.task().id().update(cancelled_task.clone());

    // Run on_done hook to clean up
    TaskPayload::on_done(&cancelled_task, ctx)?;

    log::info!("Task cancelled: id={}, sender={:?}", task_id, ctx.sender);

    Ok(())
}

// =============================================================================
// Public Helpers
// =============================================================================

/// Cleanup tasks assigned to a disconnecting robot.
/// Called from User::on_disconnect for Robot when a robot disconnects.
pub fn cleanup_robot_tasks(ctx: &ReducerContext, robot_id: Identity) {
    // Find all tasks assigned to this robot
    // Note: We iterate over all tasks since SpacetimeDB doesn't support filtering on enum variants with payloads
    let assigned_tasks: Vec<Task> = ctx
        .db
        .task()
        .iter()
        .filter(|task| matches!(&task.status, TaskStatus::Assigned(id) if *id == robot_id))
        .collect();

    for task in assigned_tasks {
        log::info!(
            "Cleaning up task {} assigned to disconnected robot {:?}",
            task.id,
            robot_id
        );

        // Delete the task
        ctx.db.task().id().delete(task.id.clone());

        // Send error notification to the task owner
        send_error(
            ctx,
            task.owner_user_id,
            "Task was interrupted because the server disconnected. Please try again.".to_string(),
        );
    }
}

/// Cleanup tasks owned by a disconnecting human.
/// Called from User::on_disconnect for Human when a user disconnects.
/// This cancels any pending tasks that were waiting for human input.
pub fn cleanup_human_tasks(ctx: &ReducerContext, human_id: Identity) {
    // Find all tasks owned by this human that are not yet completed
    let pending_tasks: Vec<Task> = ctx
        .db
        .task()
        .owner_user_id()
        .filter(&human_id)
        .filter(|task| !matches!(task.status, TaskStatus::Done))
        .collect();

    for task in pending_tasks {
        // Only cleanup tasks that are waiting for human input
        let should_cleanup = matches!(
            task.payload,
            TaskPayload::GenerateQrCode(_)
                | TaskPayload::ReceiveLoginCode(_)
                | TaskPayload::ReceivePassword(_)
        );

        if !should_cleanup {
            continue;
        }

        log::info!(
            "Cleaning up task {} owned by disconnected human {:?}",
            task.id,
            human_id
        );

        // Delete the task directly - no need to run on_done since user is disconnecting
        ctx.db.task().id().delete(task.id.clone());
    }
}
