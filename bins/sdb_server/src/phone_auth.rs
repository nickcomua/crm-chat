//! Phone authentication table and reducers.
//!
//! Tracks the entire phone-based Telegram login flow as a single-row state machine.
//! Auth secrets (phone_code_hash, password_token, login_code, password) are stored
//! in the table row and never round-trip through the frontend.

use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

use crate::client::client;
use crate::notification::send_error;
use crate::robot::robot;
use crate::validation;
use crate::{Client, ClientKind, ClientStatus};

// =============================================================================
// Step Enum
// =============================================================================

#[derive(Clone, Debug, PartialEq, spacetimedb::SpacetimeType)]
pub enum PhoneAuthStep {
    /// Robot is sending SMS code to the phone
    SendingCode,
    /// Waiting for user to enter the received code
    WaitingCode,
    /// Robot is verifying the code with Telegram
    VerifyingCode,
    /// Waiting for user to enter 2FA password
    WaitingPassword,
    /// Robot is verifying the password with Telegram
    VerifyingPassword,
    /// Successfully authenticated
    Connected,
    /// Authentication failed
    Failed,
    /// User cancelled
    Cancelled,
}

impl PhoneAuthStep {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            PhoneAuthStep::Connected | PhoneAuthStep::Failed | PhoneAuthStep::Cancelled
        )
    }
}

// =============================================================================
// Result Enums (used by robot reducers)
// =============================================================================

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct SendCodeSuccess {
    pub phone_code_hash: String,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum SendCodeResult {
    Success(SendCodeSuccess),
    AlreadyAuthorized,
    Failed(String),
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct PasswordRequiredInfo {
    pub hint: Option<String>,
    pub password_token: String,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyCodeSuccess {
    pub user_id: i64,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyCodeResult {
    Success(VerifyCodeSuccess),
    InvalidCode,
    PasswordRequired(PasswordRequiredInfo),
    SignUpRequired,
    Failed(String),
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct VerifyPasswordSuccess {
    pub user_id: i64,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum VerifyPasswordResult {
    Success(VerifyPasswordSuccess),
    InvalidPassword,
    Failed(String),
}

// =============================================================================
// PhoneAuth Table
// =============================================================================

#[spacetimedb::table(name = phone_auth, public)]
#[derive(Debug, Clone)]
pub struct PhoneAuth {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub owner_user_id: Identity,
    pub client_id: u64,
    pub phone: String,
    pub step: PhoneAuthStep,
    // Auth secrets — stored server-side, read by robot, not used by frontend
    pub phone_code_hash: Option<String>,
    pub login_code: Option<String>,
    pub password_token: Option<String>,
    pub password: Option<String>,
    pub password_hint: Option<String>,
    // Error info
    pub error: Option<String>,
    // Robot assignment (set once, stays for entire flow)
    pub assigned_robot: Option<Identity>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

// =============================================================================
// Helper Functions
// =============================================================================

fn get_phone_auth(ctx: &ReducerContext, auth_id: u64) -> Result<PhoneAuth, String> {
    ctx.db
        .phone_auth()
        .id()
        .find(auth_id)
        .ok_or("PhoneAuth not found".to_string())
}

fn require_owner(auth: &PhoneAuth, sender: Identity) -> Result<(), String> {
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

fn require_assigned_robot(auth: &PhoneAuth, sender: Identity) -> Result<(), String> {
    match auth.assigned_robot {
        Some(robot_id) if robot_id == sender => Ok(()),
        _ => Err("Unauthorized: not assigned to this robot".to_string()),
    }
}

fn require_step(auth: &PhoneAuth, expected: PhoneAuthStep) -> Result<(), String> {
    if auth.step != expected {
        return Err(format!(
            "Invalid step: expected {:?}, got {:?}",
            expected, auth.step
        ));
    }
    Ok(())
}

fn update_client_status(
    ctx: &ReducerContext,
    client_id: u64,
    new_status: ClientStatus,
) -> Result<(), String> {
    let client = ctx
        .db
        .client()
        .id()
        .find(client_id)
        .ok_or("Client not found")?;
    ctx.db.client().id().update(Client {
        status: new_status,
        ..client
    });
    Ok(())
}

fn delete_client_by_id(ctx: &ReducerContext, client_id: u64) {
    ctx.db.client().id().delete(client_id);
}

// =============================================================================
// Human Reducers
// =============================================================================

/// Start phone-based authentication for a Telegram client.
/// Creates a Client row and a PhoneAuth row in SendingCode step.
#[reducer]
pub fn start_phone_auth(ctx: &ReducerContext, phone: String) -> Result<(), String> {
    validation::phone(&phone)?;

    // Check if client already exists for this user+phone
    let existing = ctx
        .db
        .client()
        .user_client_pair()
        .filter((&ctx.sender, &phone))
        .next();
    if existing.is_some() {
        return Err("Client already exists for this phone number".to_string());
    }

    // Create the client
    let client = ctx.db.client().insert(Client {
        id: 0, // auto_inc
        owner_user_id: ctx.sender,
        kind: ClientKind::Telegram,
        external_id: phone.clone(),
        active_chats: vec![],
        status: ClientStatus::Authenticating,
    });

    // Create the PhoneAuth row
    ctx.db.phone_auth().insert(PhoneAuth {
        id: 0, // auto_inc
        owner_user_id: ctx.sender,
        client_id: client.id,
        phone: phone.clone(),
        step: PhoneAuthStep::SendingCode,
        phone_code_hash: None,
        login_code: None,
        password_token: None,
        password: None,
        password_hint: None,
        error: None,
        assigned_robot: None,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    log::info!(
        "Phone auth started: phone={}, owner={}",
        phone,
        ctx.sender
    );
    Ok(())
}

/// User submits the login code they received via SMS.
#[reducer]
pub fn submit_login_code(
    ctx: &ReducerContext,
    auth_id: u64,
    code: String,
) -> Result<(), String> {
    let auth = get_phone_auth(ctx, auth_id)?;
    require_owner(&auth, ctx.sender)?;
    require_step(&auth, PhoneAuthStep::WaitingCode)?;
    validation::auth_code(&code)?;

    ctx.db.phone_auth().id().update(PhoneAuth {
        login_code: Some(code),
        step: PhoneAuthStep::VerifyingCode,
        updated_at: ctx.timestamp,
        ..auth
    });

    log::info!("Login code submitted: auth_id={}", auth_id);
    Ok(())
}

/// User submits their 2FA password.
#[reducer]
pub fn submit_password(
    ctx: &ReducerContext,
    auth_id: u64,
    password: String,
) -> Result<(), String> {
    let auth = get_phone_auth(ctx, auth_id)?;
    require_owner(&auth, ctx.sender)?;
    require_step(&auth, PhoneAuthStep::WaitingPassword)?;
    validation::password(&password)?;

    ctx.db.phone_auth().id().update(PhoneAuth {
        password: Some(password),
        step: PhoneAuthStep::VerifyingPassword,
        updated_at: ctx.timestamp,
        ..auth
    });

    log::info!("Password submitted: auth_id={}", auth_id);
    Ok(())
}

/// User cancels the phone auth flow.
#[reducer]
pub fn cancel_phone_auth(ctx: &ReducerContext, auth_id: u64) -> Result<(), String> {
    let auth = get_phone_auth(ctx, auth_id)?;
    require_owner(&auth, ctx.sender)?;

    if auth.step.is_terminal() {
        return Err("Cannot cancel: auth is already in a terminal state".to_string());
    }

    // Delete the associated client
    delete_client_by_id(ctx, auth.client_id);

    ctx.db.phone_auth().id().update(PhoneAuth {
        step: PhoneAuthStep::Cancelled,
        updated_at: ctx.timestamp,
        ..auth
    });

    log::info!("Phone auth cancelled: auth_id={}", auth_id);
    Ok(())
}

// =============================================================================
// Robot Reducers
// =============================================================================

/// Robot claims a phone auth session. Called once; the robot stays assigned for the entire flow.
#[reducer]
pub fn robot_claim_phone_auth(ctx: &ReducerContext, auth_id: u64) -> Result<(), String> {
    require_robot(ctx)?;
    let auth = get_phone_auth(ctx, auth_id)?;
    require_step(&auth, PhoneAuthStep::SendingCode)?;

    if auth.assigned_robot.is_some() {
        return Err("PhoneAuth is already claimed by a robot".to_string());
    }

    ctx.db.phone_auth().id().update(PhoneAuth {
        assigned_robot: Some(ctx.sender),
        updated_at: ctx.timestamp,
        ..auth
    });

    log::info!(
        "Phone auth claimed: auth_id={}, robot={}",
        auth_id,
        ctx.sender
    );
    Ok(())
}

/// Robot reports the result of sending the login code.
#[reducer]
pub fn robot_complete_send_code(
    ctx: &ReducerContext,
    auth_id: u64,
    result: SendCodeResult,
) -> Result<(), String> {
    require_robot(ctx)?;
    let auth = get_phone_auth(ctx, auth_id)?;
    require_assigned_robot(&auth, ctx.sender)?;
    require_step(&auth, PhoneAuthStep::SendingCode)?;

    match result {
        SendCodeResult::Success(success) => {
            ctx.db.phone_auth().id().update(PhoneAuth {
                phone_code_hash: Some(success.phone_code_hash),
                step: PhoneAuthStep::WaitingCode,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        SendCodeResult::AlreadyAuthorized => {
            update_client_status(ctx, auth.client_id, ClientStatus::Connected)?;
            ctx.db.phone_auth().id().update(PhoneAuth {
                step: PhoneAuthStep::Connected,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        SendCodeResult::Failed(error) => {
            delete_client_by_id(ctx, auth.client_id);
            send_error(
                ctx,
                auth.owner_user_id,
                format!("Failed to send login code: {}", error),
            );
            ctx.db.phone_auth().id().update(PhoneAuth {
                step: PhoneAuthStep::Failed,
                error: Some(error),
                updated_at: ctx.timestamp,
                ..auth
            });
        }
    }

    log::info!("Send code completed: auth_id={}", auth_id);
    Ok(())
}

/// Robot reports the result of verifying the login code.
#[reducer]
pub fn robot_complete_verify_code(
    ctx: &ReducerContext,
    auth_id: u64,
    result: VerifyCodeResult,
) -> Result<(), String> {
    require_robot(ctx)?;
    let auth = get_phone_auth(ctx, auth_id)?;
    require_assigned_robot(&auth, ctx.sender)?;
    require_step(&auth, PhoneAuthStep::VerifyingCode)?;

    match result {
        VerifyCodeResult::Success(_) => {
            update_client_status(ctx, auth.client_id, ClientStatus::Connected)?;
            ctx.db.phone_auth().id().update(PhoneAuth {
                step: PhoneAuthStep::Connected,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        VerifyCodeResult::InvalidCode => {
            // Clear the code and let user retry
            send_error(
                ctx,
                auth.owner_user_id,
                "Invalid code. Please try again.".to_string(),
            );
            ctx.db.phone_auth().id().update(PhoneAuth {
                login_code: None,
                step: PhoneAuthStep::WaitingCode,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        VerifyCodeResult::PasswordRequired(info) => {
            ctx.db.phone_auth().id().update(PhoneAuth {
                password_hint: info.hint,
                password_token: Some(info.password_token),
                step: PhoneAuthStep::WaitingPassword,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        VerifyCodeResult::SignUpRequired => {
            delete_client_by_id(ctx, auth.client_id);
            send_error(
                ctx,
                auth.owner_user_id,
                "Sign up required. This phone number is not registered with Telegram.".to_string(),
            );
            ctx.db.phone_auth().id().update(PhoneAuth {
                step: PhoneAuthStep::Failed,
                error: Some("Sign up required".to_string()),
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        VerifyCodeResult::Failed(error) => {
            delete_client_by_id(ctx, auth.client_id);
            send_error(
                ctx,
                auth.owner_user_id,
                format!("Failed to verify login code: {}", error),
            );
            ctx.db.phone_auth().id().update(PhoneAuth {
                step: PhoneAuthStep::Failed,
                error: Some(error),
                updated_at: ctx.timestamp,
                ..auth
            });
        }
    }

    log::info!("Verify code completed: auth_id={}", auth_id);
    Ok(())
}

/// Robot reports the result of verifying the 2FA password.
#[reducer]
pub fn robot_complete_verify_password(
    ctx: &ReducerContext,
    auth_id: u64,
    result: VerifyPasswordResult,
) -> Result<(), String> {
    require_robot(ctx)?;
    let auth = get_phone_auth(ctx, auth_id)?;
    require_assigned_robot(&auth, ctx.sender)?;
    require_step(&auth, PhoneAuthStep::VerifyingPassword)?;

    match result {
        VerifyPasswordResult::Success(_) => {
            update_client_status(ctx, auth.client_id, ClientStatus::Connected)?;
            ctx.db.phone_auth().id().update(PhoneAuth {
                step: PhoneAuthStep::Connected,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        VerifyPasswordResult::InvalidPassword => {
            // Clear the password and let user retry (hint is preserved)
            send_error(
                ctx,
                auth.owner_user_id,
                "Invalid password. Please try again.".to_string(),
            );
            ctx.db.phone_auth().id().update(PhoneAuth {
                password: None,
                step: PhoneAuthStep::WaitingPassword,
                updated_at: ctx.timestamp,
                ..auth
            });
        }
        VerifyPasswordResult::Failed(error) => {
            delete_client_by_id(ctx, auth.client_id);
            send_error(
                ctx,
                auth.owner_user_id,
                format!("Failed to verify password: {}", error),
            );
            ctx.db.phone_auth().id().update(PhoneAuth {
                step: PhoneAuthStep::Failed,
                error: Some(error),
                updated_at: ctx.timestamp,
                ..auth
            });
        }
    }

    log::info!("Verify password completed: auth_id={}", auth_id);
    Ok(())
}

// =============================================================================
// Cleanup Helpers
// =============================================================================

/// Clean up phone auth sessions owned by a disconnecting human.
pub fn cleanup_human_phone_auths(ctx: &ReducerContext, human_id: Identity) {
    let active: Vec<PhoneAuth> = ctx
        .db
        .phone_auth()
        .owner_user_id()
        .filter(&human_id)
        .filter(|auth| !auth.step.is_terminal())
        .collect();

    for auth in active {
        log::info!(
            "Cleaning up phone auth {} for disconnected human {:?}",
            auth.id,
            human_id
        );
        ctx.db.phone_auth().id().update(PhoneAuth {
            step: PhoneAuthStep::Cancelled,
            updated_at: ctx.timestamp,
            ..auth
        });
    }
}

/// Clean up phone auth sessions assigned to a disconnecting robot.
pub fn cleanup_robot_phone_auths(ctx: &ReducerContext, robot_id: Identity) {
    let active: Vec<PhoneAuth> = ctx
        .db
        .phone_auth()
        .iter()
        .filter(|auth| auth.assigned_robot == Some(robot_id) && !auth.step.is_terminal())
        .collect();

    for auth in active {
        log::info!(
            "Cleaning up phone auth {} for disconnected robot {:?}",
            auth.id,
            robot_id
        );
        delete_client_by_id(ctx, auth.client_id);
        send_error(
            ctx,
            auth.owner_user_id,
            "Authentication was interrupted because the server disconnected. Please try again."
                .to_string(),
        );
        ctx.db.phone_auth().id().update(PhoneAuth {
            step: PhoneAuthStep::Failed,
            error: Some("Robot disconnected".to_string()),
            updated_at: ctx.timestamp,
            ..auth
        });
    }
}
