//! QR code authentication table and reducers.
//!
//! Tracks the QR code-based Telegram login flow as a single-row state machine.

use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

use crate::client::client;
use crate::notification::send_error;
use crate::robot::robot;
use crate::{Client, ClientKind, ClientStatus};

// =============================================================================
// Step Enum
// =============================================================================

#[derive(Clone, Debug, PartialEq, spacetimedb::SpacetimeType)]
pub enum QrAuthStep {
    /// Just created, waiting for robot to claim
    Pending,
    /// Robot claimed, generating QR code
    Generating,
    /// QR token available for scanning
    Token,
    /// Successfully authorized
    Authorized,
    /// Was already authorized
    AlreadyAuthorized,
    /// Authentication failed
    Failed,
    /// User cancelled
    Cancelled,
}

impl QrAuthStep {
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            QrAuthStep::Authorized
                | QrAuthStep::AlreadyAuthorized
                | QrAuthStep::Failed
                | QrAuthStep::Cancelled
        )
    }
}

// =============================================================================
// Result Enum (used by robot reducer)
// =============================================================================

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum QrAuthResult {
    Authorized { user_id: i64 },
    AlreadyAuthorized { user_id: i64 },
    Failed { error: String },
}

// =============================================================================
// QrAuth Table
// =============================================================================

#[spacetimedb::table(name = qr_auth, public)]
#[derive(Debug, Clone)]
pub struct QrAuth {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub owner_user_id: Identity,
    pub step: QrAuthStep,
    pub qr_url: Option<String>,
    pub qr_expires: Option<i32>,
    pub telegram_user_id: Option<i64>,
    pub error: Option<String>,
    pub assigned_robot: Option<Identity>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

// =============================================================================
// Helper Functions
// =============================================================================

fn get_qr_auth(ctx: &ReducerContext, auth_id: u64) -> Result<QrAuth, String> {
    ctx.db
        .qr_auth()
        .id()
        .find(auth_id)
        .ok_or("QrAuth not found".to_string())
}

fn require_owner(auth: &QrAuth, sender: Identity) -> Result<(), String> {
    if auth.owner_user_id != sender {
        return Err("Unauthorized: only the owner can perform this action".to_string());
    }
    Ok(())
}

fn require_robot(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.robot().id().find(ctx.sender).is_none() {
        return Err("Unauthorized: only robots can perform this action".to_string());
    }
    Ok(())
}

fn require_assigned_robot(auth: &QrAuth, sender: Identity) -> Result<(), String> {
    match auth.assigned_robot {
        Some(robot_id) if robot_id == sender => Ok(()),
        _ => Err("Unauthorized: not assigned to this robot".to_string()),
    }
}

// =============================================================================
// Human Reducers
// =============================================================================

/// Start QR code authentication for a Telegram client.
/// No client is created yet — that happens on successful authorization.
#[reducer]
pub fn start_qr_auth(ctx: &ReducerContext) -> Result<(), String> {
    ctx.db.qr_auth().insert(QrAuth {
        id: 0, // auto_inc
        owner_user_id: ctx.sender,
        step: QrAuthStep::Pending,
        qr_url: None,
        qr_expires: None,
        telegram_user_id: None,
        error: None,
        assigned_robot: None,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    log::info!("QR auth started: owner={}", ctx.sender);
    Ok(())
}

/// User cancels the QR auth flow.
#[reducer]
pub fn cancel_qr_auth(ctx: &ReducerContext, auth_id: u64) -> Result<(), String> {
    let auth = get_qr_auth(ctx, auth_id)?;
    require_owner(&auth, ctx.sender)?;

    if auth.step.is_terminal() {
        return Err("Cannot cancel: auth is already in a terminal state".to_string());
    }

    ctx.db.qr_auth().id().update(QrAuth {
        step: QrAuthStep::Cancelled,
        updated_at: ctx.timestamp,
        ..auth
    });

    log::info!("QR auth cancelled: auth_id={}", auth_id);
    Ok(())
}

// =============================================================================
// Robot Reducers
// =============================================================================

/// Robot claims a QR auth session.
#[reducer]
pub fn robot_claim_qr_auth(ctx: &ReducerContext, auth_id: u64) -> Result<(), String> {
    require_robot(ctx)?;
    let auth = get_qr_auth(ctx, auth_id)?;

    if auth.step != QrAuthStep::Pending {
        return Err(format!("Invalid step: expected Pending, got {:?}", auth.step));
    }

    if auth.assigned_robot.is_some() {
        return Err("QrAuth is already claimed by a robot".to_string());
    }

    ctx.db.qr_auth().id().update(QrAuth {
        assigned_robot: Some(ctx.sender),
        step: QrAuthStep::Generating,
        updated_at: ctx.timestamp,
        ..auth
    });

    log::info!(
        "QR auth claimed: auth_id={}, robot={}",
        auth_id,
        ctx.sender
    );
    Ok(())
}

/// Robot provides a new QR token for the user to scan.
#[reducer]
pub fn robot_update_qr_token(
    ctx: &ReducerContext,
    auth_id: u64,
    url: String,
    expires: i32,
) -> Result<(), String> {
    require_robot(ctx)?;
    let auth = get_qr_auth(ctx, auth_id)?;
    require_assigned_robot(&auth, ctx.sender)?;

    if auth.step.is_terminal() {
        return Err("Cannot update: auth is in a terminal state".to_string());
    }

    ctx.db.qr_auth().id().update(QrAuth {
        qr_url: Some(url),
        qr_expires: Some(expires),
        step: QrAuthStep::Token,
        updated_at: ctx.timestamp,
        ..auth
    });

    log::info!("QR token updated: auth_id={}", auth_id);
    Ok(())
}

/// Robot reports the final result of QR authentication.
#[reducer]
pub fn robot_complete_qr_auth(
    ctx: &ReducerContext,
    auth_id: u64,
    result: QrAuthResult,
) -> Result<(), String> {
    require_robot(ctx)?;
    let auth = get_qr_auth(ctx, auth_id)?;
    require_assigned_robot(&auth, ctx.sender)?;

    if auth.step.is_terminal() {
        return Err("Cannot complete: auth is already in a terminal state".to_string());
    }

    match result {
        QrAuthResult::Authorized { user_id } | QrAuthResult::AlreadyAuthorized { user_id } => {
            let external_id = user_id.to_string();
            let is_already = matches!(result, QrAuthResult::AlreadyAuthorized { .. });
            let step = if is_already {
                QrAuthStep::AlreadyAuthorized
            } else {
                QrAuthStep::Authorized
            };

            // Find or create the client
            let existing = ctx
                .db
                .client()
                .user_client_pair()
                .filter((&auth.owner_user_id, &external_id))
                .next();

            if let Some(existing) = existing {
                ctx.db.client().id().update(Client {
                    status: ClientStatus::Connected,
                    ..existing
                });
            } else {
                ctx.db.client().insert(Client {
                    id: 0,
                    owner_user_id: auth.owner_user_id,
                    kind: ClientKind::Telegram,
                    external_id,
                    active_chats: vec![],
                    status: ClientStatus::Connected,
                });
            }

            ctx.db.qr_auth().id().update(QrAuth {
                telegram_user_id: Some(user_id),
                step,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        QrAuthResult::Failed { error } => {
            send_error(
                ctx,
                auth.owner_user_id,
                format!("QR code login failed: {}", error),
            );
            ctx.db.qr_auth().id().update(QrAuth {
                step: QrAuthStep::Failed,
                error: Some(error),
                updated_at: ctx.timestamp,
                ..auth
            });
        }
    }

    log::info!("QR auth completed: auth_id={}", auth_id);
    Ok(())
}

// =============================================================================
// Cleanup Helpers
// =============================================================================

/// Clean up QR auth sessions owned by a disconnecting human.
pub fn cleanup_human_qr_auths(ctx: &ReducerContext, human_id: Identity) {
    let active: Vec<QrAuth> = ctx
        .db
        .qr_auth()
        .owner_user_id()
        .filter(&human_id)
        .filter(|auth| !auth.step.is_terminal())
        .collect();

    for auth in active {
        log::info!(
            "Cleaning up QR auth {} for disconnected human {:?}",
            auth.id,
            human_id
        );
        ctx.db.qr_auth().id().update(QrAuth {
            step: QrAuthStep::Cancelled,
            updated_at: ctx.timestamp,
            ..auth
        });
    }
}

/// Clean up QR auth sessions assigned to a disconnecting robot.
pub fn cleanup_robot_qr_auths(ctx: &ReducerContext, robot_id: Identity) {
    let active: Vec<QrAuth> = ctx
        .db
        .qr_auth()
        .iter()
        .filter(|auth| auth.assigned_robot == Some(robot_id) && !auth.step.is_terminal())
        .collect();

    for auth in active {
        log::info!(
            "Cleaning up QR auth {} for disconnected robot {:?}",
            auth.id,
            robot_id
        );
        send_error(
            ctx,
            auth.owner_user_id,
            "Authentication was interrupted because the server disconnected. Please try again."
                .to_string(),
        );
        ctx.db.qr_auth().id().update(QrAuth {
            step: QrAuthStep::Failed,
            error: Some("Robot disconnected".to_string()),
            updated_at: ctx.timestamp,
            ..auth
        });
    }
}
