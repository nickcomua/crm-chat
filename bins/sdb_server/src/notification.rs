//! Notification table and reducers for user-facing messages.
//!
//! Replaces the old DisplayMessage task with a simpler table-based approach.

use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

// =============================================================================
// Severity Enum
// =============================================================================

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum MessageSeverity {
    Info,
    Warning,
    Error,
}

// =============================================================================
// Notification Table
// =============================================================================

#[spacetimedb::table(name = notification, public)]
#[derive(Debug, Clone)]
pub struct Notification {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub owner_user_id: Identity,
    pub severity: MessageSeverity,
    pub message: String,
    pub dismissed: bool,
    pub created_at: Timestamp,
}

// =============================================================================
// Internal Helpers
// =============================================================================

/// Create a notification for the given user. Internal helper, not a public reducer.
pub(crate) fn send_notification(
    ctx: &ReducerContext,
    owner_user_id: Identity,
    severity: MessageSeverity,
    message: String,
) {
    ctx.db.notification().insert(Notification {
        id: 0, // auto_inc
        owner_user_id,
        severity,
        message,
        dismissed: false,
        created_at: ctx.timestamp,
    });
}

/// Convenience helper to send an error notification.
pub(crate) fn send_error(ctx: &ReducerContext, owner_user_id: Identity, message: String) {
    send_notification(ctx, owner_user_id, MessageSeverity::Error, message);
}

// =============================================================================
// Reducers
// =============================================================================

/// Dismiss a notification. Only the owner can dismiss their own notifications.
#[reducer]
pub fn dismiss_notification(ctx: &ReducerContext, notification_id: u64) -> Result<(), String> {
    let notif = ctx
        .db
        .notification()
        .id()
        .find(notification_id)
        .ok_or("Notification not found")?;

    if notif.owner_user_id != ctx.sender {
        return Err("Unauthorized: only the notification owner can dismiss it".to_string());
    }

    if notif.dismissed {
        return Err("Notification is already dismissed".to_string());
    }

    ctx.db.notification().id().update(Notification {
        dismissed: true,
        ..notif
    });

    log::info!("Notification dismissed: id={}", notification_id);
    Ok(())
}
