/// Logical schema of the one workspace store. Later tickets append a migration
/// that keeps existing rows; they do not open a second database.
pub const SCHEMA_VERSION: u32 = 1;

/// Desktop file, beside the TDLib directory in the app-data folder.
pub const DESKTOP_WORKSPACE_FILE: &str = "workspace.sqlite";

/// Web IndexedDB name for this origin. It is not the desktop file.
pub const WEB_WORKSPACE_DATABASE: &str = "crm-chat-workspace";

pub const STAGE_NEW_ID: &str = "stage-new";
pub const STAGE_WORKING_ID: &str = "stage-working";
pub const STAGE_WAITING_ID: &str = "stage-waiting";
pub const STAGE_READY_ID: &str = "stage-ready";
pub const MEMBER_YOU_ID: &str = "member-you";
pub const MEMBER_YOU_NAME: &str = "You";

/// Field names an adapter payload must not persist. Matching ignores case and
/// `_` / `-`, so `api_hash` and `apiHash` are the same field.
pub const SECRET_FIELD_NAMES: &[&str] = &[
    "api_hash",
    "api_id",
    "session",
    "session_string",
    "access_hash",
    "phone_code",
    "authorization_key",
    "auth_key",
    "database_encryption_key",
    "cloud_password",
    "password",
    "password_hash",
];

pub fn normalize_field_name(name: &str) -> String {
    name.chars()
        .filter(|character| *character != '_' && *character != '-')
        .flat_map(|character| character.to_lowercase())
        .collect()
}

pub fn is_secret_field(name: &str) -> bool {
    let normalized = normalize_field_name(name);
    SECRET_FIELD_NAMES
        .iter()
        .any(|candidate| normalize_field_name(candidate) == normalized)
}

pub fn next_case_number(used: impl IntoIterator<Item = u32>) -> u32 {
    used.into_iter().max().unwrap_or(0).saturating_add(1)
}

pub fn require_case_title(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    let count = trimmed.chars().count();
    if count == 0 || count > 120 {
        return Err("case title must be 1 to 120 characters");
    }
    Ok(trimmed.to_owned())
}

pub fn require_snapshot_text(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if trimmed.chars().count() > 500 {
        return Err("snapshot text must be at most 500 characters");
    }
    Ok(trimmed.to_owned())
}

pub fn require_outcome_note(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if trimmed.chars().count() > 500 {
        return Err("outcome note must be at most 500 characters");
    }
    Ok(trimmed.to_owned())
}
