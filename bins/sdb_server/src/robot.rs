//! Robot table for background worker authentication.

use spacetimedb::{Identity, Timestamp};

#[spacetimedb::table(name = robot, public)]
pub struct Robot {
    #[primary_key]
    pub id: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub online: bool,
}
