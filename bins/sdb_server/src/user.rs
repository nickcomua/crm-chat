//! Human table and User trait for authentication lifecycle.

use serde::{Deserialize, Serialize};
use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};
use std::str::FromStr;

use crate::robot::{robot, Robot};
use crate::task::{cleanup_human_tasks, cleanup_robot_tasks};

// =============================================================================
// User Trait - Defines lifecycle hooks for authenticated entities
// =============================================================================

/// Trait for entities that can connect and disconnect from SpacetimeDB.
/// Both Human users and Robot workers implement this trait.
pub trait User {
    /// Called when this entity connects to SpacetimeDB.
    fn on_connect(ctx: &ReducerContext) -> Result<(), String>;

    /// Called when this entity disconnects from SpacetimeDB.
    fn on_disconnect(ctx: &ReducerContext);
}

// =============================================================================
// Human Table - Real users authenticated via Clerk
// =============================================================================

#[spacetimedb::table(name = human, public)]
pub struct Human {
    #[primary_key]
    pub id: Identity,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub online: bool,
}

// === JWT Claims ===

#[derive(Debug, Serialize, Deserialize)]
struct BasicClaims {
    email: Option<String>,
    name: Option<String>,
}

// =============================================================================
// User Trait Implementation for Human
// =============================================================================

impl User for Human {
    fn on_connect(ctx: &ReducerContext) -> Result<(), String> {
        let jwt = ctx
            .sender_auth()
            .jwt()
            .ok_or("Authentication required".to_string())?;

        // Validate issuer for human authentication
        if !["https://noted-rabbit-14.clerk.accounts.dev", "https://auth.spacetimedb.com"]
            .contains(&jwt.issuer())
        {
            return Err("Invalid issuer".to_string());
        }

        let claims: BasicClaims = serde_json::from_slice(jwt.raw_payload().as_bytes())
            .map_err(|e| format!("Client connected with invalid JWT: {}", e))?;

        if let Some(human) = ctx.db.human().id().find(ctx.sender) {
            // Check if human is already connected
            if human.online {
                return Err("Human already connected".to_string());
            }
            // Returning human: update online status and claims
            ctx.db.human().id().update(Human {
                online: true,
                updated_at: ctx.timestamp,
                username: claims.email,
                display_name: claims.name,
                ..human
            });
        } else {
            // New human: create record
            ctx.db.human().insert(Human {
                id: ctx.sender,
                username: claims.email,
                display_name: claims.name,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
                online: true,
            });
        }

        log::info!("Human connected: {:?}", ctx.sender);
        Ok(())
    }

    fn on_disconnect(ctx: &ReducerContext) {
        if let Some(human) = ctx.db.human().id().find(ctx.sender) {
            // Clean up any pending tasks owned by this human
            cleanup_human_tasks(ctx, ctx.sender);

            ctx.db.human().id().update(Human {
                online: false,
                updated_at: ctx.timestamp,
                ..human
            });
            log::info!("Human disconnected: {:?}", ctx.sender);
        }
    }
}

// =============================================================================
// User Trait Implementation for Robot
// =============================================================================

impl User for Robot {
    fn on_connect(ctx: &ReducerContext) -> Result<(), String> {
        let jwt = ctx
            .sender_auth()
            .jwt()
            .ok_or("Authentication required".to_string())?;

        // Validate robot authentication (localhost issuer)
        if jwt.issuer() != "localhost" {
            return Err("Invalid issuer for robot".to_string());
        }

        if ctx.sender
            != Identity::from_str(
                #[allow(clippy::option_env_unwrap)]
                // DIRTY_IDENTITY env should be in a build time. option_env only for ci
                option_env!("DIRTY_IDENTITY")
                    .expect("DIRTY_IDENTITY env should be in a build time. option_env only for ci"),
            )
            .expect("Invalid identity env")
        {
            return Err("Invalid robot identity".to_string());
        }

        if let Some(robot) = ctx.db.robot().id().find(ctx.sender) {
            ctx.db.robot().id().update(Robot {
                id: ctx.sender,
                online: true,
                updated_at: ctx.timestamp,
                ..robot
            });
        } else {
            ctx.db.robot().insert(Robot {
                id: ctx.sender,
                online: true,
                updated_at: ctx.timestamp,
                created_at: ctx.timestamp,
            });
        }

        log::info!("Robot connected: {:?}", ctx.sender);
        Ok(())
    }

    fn on_disconnect(ctx: &ReducerContext) {
        if let Some(robot) = ctx.db.robot().id().find(ctx.sender) {
            // Clean up any tasks assigned to this robot
            cleanup_robot_tasks(ctx, ctx.sender);

            ctx.db.robot().id().update(Robot {
                id: ctx.sender,
                online: false,
                updated_at: ctx.timestamp,
                ..robot
            });
            log::info!("Robot disconnected: {:?}", ctx.sender);
        }
    }
}

// =============================================================================
// Connection Reducers
// =============================================================================

#[reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) -> Result<(), String> {
    log::info!("Client connecting with identity: {:?}", ctx.sender);

    // Check if JWT is present
    if let Some(jwt) = ctx.sender_auth().jwt() {
        // Authenticated connection - route based on issuer
        if jwt.issuer() == "localhost" {
            Robot::on_connect(ctx)
        } else {
            Human::on_connect(ctx)
        }
    } else {
        // Anonymous connection - create a basic human record
        if let Some(human) = ctx.db.human().id().find(ctx.sender) {
            // Check if human is already connected
            if human.online {
                return Err("Human already connected".to_string());
            }
            // Returning anonymous user: update online status
            ctx.db.human().id().update(Human {
                online: true,
                updated_at: ctx.timestamp,
                ..human
            });
        } else {
            // New anonymous user: create record
            ctx.db.human().insert(Human {
                id: ctx.sender,
                username: None,
                display_name: None,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
                online: true,
            });
        }
        
        log::info!("Anonymous human connected: {:?}", ctx.sender);
        Ok(())
    }
}

#[reducer(client_disconnected)]
pub fn identity_disconnected(ctx: &ReducerContext) {
    // Try human first, then robot
    if ctx.db.human().id().find(ctx.sender).is_some() {
        Human::on_disconnect(ctx);
    } else if ctx.db.robot().id().find(ctx.sender).is_some() {
        Robot::on_disconnect(ctx);
    } else {
        log::warn!(
            "Disconnect event for unknown identity {:?}",
            ctx.sender
        );
    }
}
