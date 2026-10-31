//! One workspace store per installation.
//!
//! Desktop opens `workspace.sqlite` in app data. The web shell opens IndexedDB
//! `crm-chat-workspace` with the same `schema_version`. Cases are tables in
//! this store. A session, API id, API hash, or `access_hash` is not a column.

use std::path::{Path, PathBuf};

use crm_chat_core::{
    login_record, next_case_number, require_case_title, require_outcome_note,
    require_snapshot_text, seeded_member, seeded_stages, AccountLabel, Case, CaseBundle, CaseChat,
    CaseDraft, CaseMessage, CaseOutcome, CaseParticipant, CaseRole, CaseStatus, Payload,
    UnixMillis, SCHEMA_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;

const JSON_TABLES: &[&str] = &[
    "people",
    "account_labels",
    "account_refs",
    "chat_triage",
    "contacts",
    "chat_contact_links",
    "facts",
    "pins",
    "templates",
    "follow_ups",
    "internal_notes",
    "deals",
    "ai_drafts",
    "members",
    "account_grants",
    "assignments",
    "handoffs",
    "webhook_endpoints",
    "webhook_deliveries",
    "stages",
];

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Invalid(&'static str),
    DuplicateLink,
    NewerSchema { found: u32 },
    Missing,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "workspace store: {error}"),
            Self::Json(error) => write!(formatter, "workspace row: {error}"),
            Self::Invalid(message) => write!(formatter, "{message}"),
            Self::DuplicateLink => {
                write!(formatter, "that message is already linked to this case")
            }
            Self::NewerSchema { found } => write!(
                formatter,
                "workspace schema {found} is newer than this build"
            ),
            Self::Missing => write!(formatter, "missing workspace row"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

struct Step {
    version: u32,
    apply: fn(&Connection) -> Result<(), StoreError>,
}

pub struct Workspace {
    conn: Connection,
    path: PathBuf,
}

impl Workspace {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::open_at(path, &production_steps(), SCHEMA_VERSION)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> Result<u32, StoreError> {
        self.conn
            .query_row(
                "SELECT schema_version FROM schema_meta WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }

    pub fn put_record<T: Serialize>(
        &self,
        table: &'static str,
        id: &str,
        value: &T,
    ) -> Result<(), StoreError> {
        let table = json_table(table)?;
        let body = serde_json::to_string(value)?;
        self.conn.execute(
            &format!(
                "INSERT INTO {table} (id, body) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET body = excluded.body"
            ),
            params![id, body],
        )?;
        Ok(())
    }

    pub fn get_record<T: DeserializeOwned>(
        &self,
        table: &'static str,
        id: &str,
    ) -> Result<Option<T>, StoreError> {
        let table = json_table(table)?;
        let body: Option<String> = self
            .conn
            .query_row(
                &format!("SELECT body FROM {table} WHERE id = ?1"),
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        body.map(|body| serde_json::from_str(&body).map_err(StoreError::from))
            .transpose()
    }

    pub fn record_login(
        &self,
        account_id: &str,
        label: &str,
        payload: &Payload,
        now: UnixMillis,
    ) -> Result<AccountLabel, StoreError> {
        let record = login_record(account_id, label, payload);
        if record.account_id.is_empty() {
            return Err(StoreError::Invalid("account id is empty"));
        }
        let row = AccountLabel {
            account_id: record.account_id,
            label: record.label,
            updated_at: now,
            observed_name: record.observed_name,
            connection: "connected".to_owned(),
        };
        self.put_record("account_labels", &row.account_id, &row)?;
        Ok(row)
    }

    /// Login may pass an account id and title only. The payload is built here
    /// so an API hash cannot be handed to the store by a shell command.
    pub fn remember_account(&self, account_id: &str, title: &str) -> Result<(), StoreError> {
        let payload = crm_chat_core::safe_login_payload(account_id, title);
        self.record_login(account_id, title, &payload, now_millis())?;
        Ok(())
    }

    pub fn note_logout(&self, account_id: &str) -> Result<(), StoreError> {
        self.set_connection(account_id, "logged_out")
    }

    pub fn note_account_removed(&self, account_id: &str) -> Result<(), StoreError> {
        self.set_connection(account_id, "removed")
    }

    pub fn insert_case(
        &mut self,
        draft: CaseDraft,
        now: UnixMillis,
    ) -> Result<CaseBundle, StoreError> {
        let title = require_case_title(&draft.title).map_err(StoreError::Invalid)?;
        one_primary(
            &draft.chats,
            |chat| chat.role,
            "a case has one primary chat",
        )?;
        one_primary(
            &draft.participants,
            |participant| participant.role,
            "a case has one primary participant",
        )?;
        let transaction = self.conn.transaction()?;
        let used = case_numbers(&transaction)?;
        let number = next_case_number(used);
        let case = Case {
            id: draft.id.clone(),
            number,
            title,
            kind: draft.kind,
            status: CaseStatus::Open,
            stage_id: draft.stage_id,
            outcome: CaseOutcome::None,
            outcome_note: String::new(),
            amount_minor: None,
            currency: None,
            priority: draft.priority,
            owner_id: draft.owner_id,
            due_at: draft.due_at,
            follow_up_at: draft.follow_up_at,
            reply_account_id: draft.reply_account_id,
            primary_chat: draft.primary_chat,
            created_at: now,
            updated_at: now,
            closed_at: None,
            last_opened_at: None,
        };
        write_case(&transaction, &case)?;
        for mut chat in draft.chats {
            chat.case_id = case.id.clone();
            write_chat(&transaction, &chat)?;
        }
        for mut participant in draft.participants {
            participant.case_id = case.id.clone();
            write_participant(&transaction, &participant)?;
        }
        for mut message in draft.messages {
            message.case_id = case.id.clone();
            message.snapshot.text =
                require_snapshot_text(&message.snapshot.text).map_err(StoreError::Invalid)?;
            write_message(&transaction, &message)?;
        }
        for mut note in draft.notes {
            note.case_id = case.id.clone();
            write_child(
                &transaction,
                "case_notes",
                &note.id.0,
                &note.case_id.0,
                &note,
            )?;
        }
        for mut file in draft.files {
            file.case_id = case.id.clone();
            write_child(
                &transaction,
                "case_files",
                &file.id.0,
                &file.case_id.0,
                &file,
            )?;
        }
        for mut event in draft.events {
            event.case_id = case.id.clone();
            write_child(
                &transaction,
                "case_events",
                &event.id.0,
                &event.case_id.0,
                &event,
            )?;
        }
        transaction.commit()?;
        self.case_bundle(&case.id.0)?.ok_or(StoreError::Missing)
    }

    pub fn attach_message(&self, mut message: CaseMessage) -> Result<(), StoreError> {
        if message.message.message_id.is_empty() {
            return Err(StoreError::Invalid("message id is empty"));
        }
        message.snapshot.text =
            require_snapshot_text(&message.snapshot.text).map_err(StoreError::Invalid)?;
        write_message(&self.conn, &message)
    }

    pub fn close_case(
        &self,
        id: &str,
        outcome: CaseOutcome,
        note: &str,
        at: UnixMillis,
    ) -> Result<Case, StoreError> {
        let outcome_note = require_outcome_note(note).map_err(StoreError::Invalid)?;
        let mut bundle = self.case_bundle(id)?.ok_or(StoreError::Missing)?;
        bundle.case.status = CaseStatus::Closed;
        bundle.case.outcome = outcome;
        bundle.case.outcome_note = outcome_note;
        bundle.case.closed_at = Some(at);
        bundle.case.updated_at = at;
        write_case(&self.conn, &bundle.case)?;
        Ok(bundle.case)
    }

    pub fn case_bundle(&self, id: &str) -> Result<Option<CaseBundle>, StoreError> {
        let Some(case) = self.case_row(id)? else {
            return Ok(None);
        };
        Ok(Some(CaseBundle {
            case,
            chats: children(
                &self.conn,
                "SELECT body FROM case_chats WHERE case_id = ?1 ORDER BY rowid",
                id,
            )?,
            participants: children(
                &self.conn,
                "SELECT body FROM case_participants WHERE case_id = ?1 ORDER BY rowid",
                id,
            )?,
            messages: children(
                &self.conn,
                "SELECT body FROM case_messages WHERE case_id = ?1 ORDER BY rowid",
                id,
            )?,
            notes: children(
                &self.conn,
                "SELECT body FROM case_notes WHERE case_id = ?1 ORDER BY rowid",
                id,
            )?,
            files: children(
                &self.conn,
                "SELECT body FROM case_files WHERE case_id = ?1 ORDER BY rowid",
                id,
            )?,
            events: children(
                &self.conn,
                "SELECT body FROM case_events WHERE case_id = ?1 ORDER BY rowid",
                id,
            )?,
        }))
    }

    pub fn list_open_cases(&self) -> Result<Vec<Case>, StoreError> {
        rows(
            &self.conn,
            "SELECT body FROM cases WHERE status = 'Open' ORDER BY updated_at DESC, number DESC",
            [],
        )
    }

    pub fn cases_with_follow_up_due(&self, now: UnixMillis) -> Result<Vec<Case>, StoreError> {
        rows(
            &self.conn,
            "SELECT body FROM cases WHERE follow_up_at IS NOT NULL AND follow_up_at <= ?1 ORDER BY follow_up_at",
            params![now.0],
        )
    }

    pub fn case_ids_for_chat(
        &self,
        account_id: &str,
        chat_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let mut statement = self.conn.prepare(
            "SELECT case_id FROM case_chats WHERE account_id = ?1 AND chat_id = ?2 ORDER BY rowid",
        )?;
        let found = statement.query_map(params![account_id, chat_id], |row| row.get(0))?;
        let mut ids = Vec::new();
        for id in found {
            ids.push(id?);
        }
        Ok(ids)
    }

    pub fn messages_for(
        &self,
        account_id: &str,
        chat_id: &str,
        message_id: &str,
    ) -> Result<Vec<CaseMessage>, StoreError> {
        rows(
            &self.conn,
            "SELECT body FROM case_messages WHERE account_id = ?1 AND chat_id = ?2 AND message_id = ?3 ORDER BY rowid",
            params![account_id, chat_id, message_id],
        )
    }

    fn case_row(&self, id: &str) -> Result<Option<Case>, StoreError> {
        optional_body(
            &self.conn,
            "SELECT body FROM cases WHERE id = ?1",
            params![id],
        )
    }

    fn set_connection(&self, account_id: &str, connection: &str) -> Result<(), StoreError> {
        let Some(mut row) = self.get_record::<AccountLabel>("account_labels", account_id)? else {
            return Ok(());
        };
        row.connection = connection.to_owned();
        self.put_record("account_labels", account_id, &row)
    }

    fn open_at(path: &Path, steps: &[Step], supported: u32) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| StoreError::Invalid("could not create the workspace directory"))?;
            }
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "DELETE")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let current = user_version(&conn)?;
        if current > supported {
            return Err(StoreError::NewerSchema { found: current });
        }
        apply_pending(&conn, steps)?;
        seed(&conn)?;
        Ok(Self {
            conn,
            path: path.to_path_buf(),
        })
    }
}

pub fn install_path(app_data: &Path) -> PathBuf {
    app_data.join(crm_chat_core::DESKTOP_WORKSPACE_FILE)
}

fn now_millis() -> UnixMillis {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let millis = u64::try_from(millis).unwrap_or(u64::MAX);
    UnixMillis(i64::try_from(millis).unwrap_or(i64::MAX))
}

pub fn remove_store(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn production_steps() -> Vec<Step> {
    vec![Step {
        version: 1,
        apply: migrate_v1,
    }]
}

fn apply_pending(conn: &Connection, steps: &[Step]) -> Result<(), StoreError> {
    let mut current = user_version(conn)?;
    for step in steps {
        if step.version <= current {
            continue;
        }
        let transaction = conn.unchecked_transaction()?;
        (step.apply)(&transaction)?;
        set_version(&transaction, step.version)?;
        transaction.commit()?;
        current = step.version;
    }
    Ok(())
}

fn migrate_v1(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(include_str!("schema_v1.sql"))?;
    Ok(())
}

fn user_version(conn: &Connection) -> Result<u32, StoreError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    u32::try_from(version).map_err(|_| StoreError::Invalid("schema version does not fit"))
}

fn set_version(conn: &Connection, version: u32) -> Result<(), StoreError> {
    conn.pragma_update(None, "user_version", version)?;
    conn.execute(
        "UPDATE schema_meta SET schema_version = ?1 WHERE id = 1",
        params![version],
    )?;
    Ok(())
}

fn seed(conn: &Connection) -> Result<(), StoreError> {
    for stage in seeded_stages() {
        insert_ignore(conn, "stages", &stage.id.0, &stage)?;
    }
    let member = seeded_member();
    insert_ignore(conn, "members", &member.id.0, &member)?;
    Ok(())
}

fn insert_ignore<T: Serialize>(
    conn: &Connection,
    table: &str,
    id: &str,
    value: &T,
) -> Result<(), StoreError> {
    let table = json_table(table)?;
    let body = serde_json::to_string(value)?;
    conn.execute(
        &format!("INSERT OR IGNORE INTO {table} (id, body) VALUES (?1, ?2)"),
        params![id, body],
    )?;
    Ok(())
}

fn json_table(table: &str) -> Result<&'static str, StoreError> {
    JSON_TABLES
        .iter()
        .copied()
        .find(|candidate| *candidate == table)
        .ok_or(StoreError::Invalid("unknown workspace table"))
}

fn one_primary<T>(
    rows: &[T],
    role: impl Fn(&T) -> CaseRole,
    message: &'static str,
) -> Result<(), StoreError> {
    let count = rows
        .iter()
        .filter(|row| role(row) == CaseRole::Primary)
        .count();
    if count > 1 {
        Err(StoreError::Invalid(message))
    } else {
        Ok(())
    }
}

fn case_numbers(conn: &Connection) -> Result<Vec<u32>, StoreError> {
    let mut statement = conn.prepare("SELECT number FROM cases")?;
    let numbers = statement.query_map([], |row| row.get::<_, i64>(0))?;
    let mut used = Vec::new();
    for number in numbers {
        let number = u32::try_from(number?).map_err(|_| StoreError::Invalid("case number"))?;
        used.push(number);
    }
    Ok(used)
}

fn status_name(status: CaseStatus) -> &'static str {
    match status {
        CaseStatus::Open => "Open",
        CaseStatus::Closed => "Closed",
    }
}

fn write_case(conn: &Connection, case: &Case) -> Result<(), StoreError> {
    let body = serde_json::to_string(case)?;
    let follow_up = case.follow_up_at.map(|at| at.0);
    conn.execute(
        "INSERT INTO cases (id, number, status, updated_at, follow_up_at, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           number = excluded.number,
           status = excluded.status,
           updated_at = excluded.updated_at,
           follow_up_at = excluded.follow_up_at,
           body = excluded.body",
        params![
            case.id.0,
            case.number,
            status_name(case.status),
            case.updated_at.0,
            follow_up,
            body
        ],
    )?;
    Ok(())
}

fn write_chat(conn: &Connection, chat: &CaseChat) -> Result<(), StoreError> {
    let body = serde_json::to_string(chat)?;
    conn.execute(
        "INSERT INTO case_chats (case_id, account_id, chat_id, body) VALUES (?1, ?2, ?3, ?4)",
        params![
            chat.case_id.0,
            chat.chat.account_id,
            chat.chat.chat_id.0,
            body
        ],
    )?;
    Ok(())
}

fn write_participant(conn: &Connection, participant: &CaseParticipant) -> Result<(), StoreError> {
    let body = serde_json::to_string(participant)?;
    conn.execute(
        "INSERT INTO case_participants (case_id, telegram_user_id, body) VALUES (?1, ?2, ?3)",
        params![participant.case_id.0, participant.telegram_user_id, body],
    )?;
    Ok(())
}

fn write_message(conn: &Connection, message: &CaseMessage) -> Result<(), StoreError> {
    if message.message.message_id.is_empty() {
        return Err(StoreError::Invalid("message id is empty"));
    }
    let body = serde_json::to_string(message)?;
    let result = conn.execute(
        "INSERT INTO case_messages (case_id, account_id, chat_id, message_id, body)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            message.case_id.0,
            message.message.account_id,
            message.message.chat_id.0,
            message.message.message_id,
            body
        ],
    );
    match result {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(error, _))
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Err(StoreError::DuplicateLink)
        }
        Err(error) => Err(StoreError::Sqlite(error)),
    }
}

fn write_child<T: Serialize>(
    conn: &Connection,
    table: &str,
    id: &str,
    case_id: &str,
    value: &T,
) -> Result<(), StoreError> {
    let table = match table {
        "case_notes" | "case_files" | "case_events" => table,
        _ => return Err(StoreError::Invalid("unknown case table")),
    };
    let body = serde_json::to_string(value)?;
    conn.execute(
        &format!("INSERT INTO {table} (id, case_id, body) VALUES (?1, ?2, ?3)"),
        params![id, case_id, body],
    )?;
    Ok(())
}

fn children<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    case_id: &str,
) -> Result<Vec<T>, StoreError> {
    rows(conn, sql, params![case_id])
}

fn rows<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<Vec<T>, StoreError> {
    let mut statement = conn.prepare(sql)?;
    let found = statement.query_map(parameters, |row| row.get::<_, String>(0))?;
    let mut values = Vec::new();
    for body in found {
        values.push(serde_json::from_str(&body?)?);
    }
    Ok(values)
}

fn optional_body<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<Option<T>, StoreError> {
    let body: Option<String> = conn
        .query_row(sql, parameters, |row| row.get(0))
        .optional()?;
    body.map(|body| serde_json::from_str(&body).map_err(StoreError::from))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crm_chat_core::{
        row_id, safe_login_payload, AccountGrant, AccountRef, AccountVisibility, AiDraft,
        AiDraftKind, Assignment, AssignmentId, ByteLength, CaseChat, CaseEvent, CaseEventKind,
        CaseFile, CaseId, CaseKind, CaseMessage, CaseNote, CaseOutcome, CaseParticipant, CaseRole,
        CaseStatus, ChatContactLink, ChatId, ChatTriage, Contact, ContactId, CustomField, Deal,
        DealId, EventId, Fact, FactId, FactKind, FactSource, FieldType, FileId, FileSourceKind,
        FollowUp, FollowUpId, FollowUpStatus, Handoff, HandoffId, InternalNote, InternalNoteId,
        MediaKind, Member, MemberId, MemberRole, MessageRef, MessageSnapshot, MinorUnits, NoteId,
        Person, PersonId, Pin, PinId, Priority, SendGrant, StageId, Template, TemplateId,
        TemplateScope, WebhookDelivery, WebhookDeliveryId, WebhookEndpoint, WebhookEndpointId,
        DESKTOP_WORKSPACE_FILE, MEMBER_YOU_ID, SCHEMA_VERSION, STAGE_WORKING_ID,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "crm-chat-workspace-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn file_text(path: &Path) -> String {
        let mut bytes = std::fs::read(path).unwrap_or_default();
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
            if let Ok(more) = std::fs::read(sidecar) {
                bytes.extend(more);
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn sample_person() -> Person {
        Person {
            id: PersonId("person-olena".to_owned()),
            display_name: "Olena".to_owned(),
            name_overridden: false,
            created_at: UnixMillis(10),
            updated_at: UnixMillis(11),
            pinned_in_people: true,
        }
    }

    #[test]
    fn a_new_profile_reopens_the_same_file() {
        let dir = temp_dir();
        let path = install_path(&dir);
        assert_eq!(path.file_name().unwrap(), DESKTOP_WORKSPACE_FILE);
        let store = Workspace::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        store
            .put_record("people", "person-olena", &sample_person())
            .unwrap();
        drop(store);
        let again = Workspace::open(&path).unwrap();
        let person = again
            .get_record::<Person>("people", "person-olena")
            .unwrap()
            .unwrap();
        assert_eq!(person.display_name, "Olena");
        let copies = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() == DESKTOP_WORKSPACE_FILE)
            .count();
        assert_eq!(copies, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn two_installations_do_not_share_rows() {
        let first_dir = temp_dir();
        let second_dir = temp_dir();
        let first = Workspace::open(&install_path(&first_dir)).unwrap();
        let second = Workspace::open(&install_path(&second_dir)).unwrap();
        first
            .put_record("people", "person-olena", &sample_person())
            .unwrap();
        assert!(second
            .get_record::<Person>("people", "person-olena")
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(first_dir);
        let _ = std::fs::remove_dir_all(second_dir);
    }

    #[test]
    fn deleting_the_file_starts_an_empty_store() {
        let dir = temp_dir();
        let path = install_path(&dir);
        let store = Workspace::open(&path).unwrap();
        store
            .put_record("people", "person-olena", &sample_person())
            .unwrap();
        drop(store);
        remove_store(&path).unwrap();
        let store = Workspace::open(&path).unwrap();
        assert!(store
            .get_record::<Person>("people", "person-olena")
            .unwrap()
            .is_none());
        assert_eq!(store.schema_version().unwrap(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn every_record_round_trips() {
        let dir = temp_dir();
        let mut store = Workspace::open(&install_path(&dir)).unwrap();
        let person = sample_person();
        store.put_record("people", &person.id.0, &person).unwrap();
        let label = AccountLabel {
            account_id: "acct-1".to_owned(),
            label: "Work".to_owned(),
            updated_at: UnixMillis(12),
            observed_name: "Olena".to_owned(),
            connection: "connected".to_owned(),
        };
        store
            .put_record("account_labels", &label.account_id, &label)
            .unwrap();
        let account_ref = AccountRef {
            telegram_user_id: "42".to_owned(),
            title: "Work".to_owned(),
            color: "#246".to_owned(),
            connection: "connected".to_owned(),
        };
        store
            .put_record("account_refs", &account_ref.telegram_user_id, &account_ref)
            .unwrap();
        let triage = ChatTriage {
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            done_through_message_id: "9".to_owned(),
            snoozed_until: Some(UnixMillis(30)),
            manually_flagged: true,
        };
        let triage_id = row_id(&[&triage.telegram_user_id, &triage.chat_id]);
        store
            .put_record("chat_triage", &triage_id, &triage)
            .unwrap();
        let contact = Contact {
            id: ContactId("contact-1".to_owned()),
            display_name: "Olena".to_owned(),
            notes: "buyer".to_owned(),
            custom_fields: vec![CustomField {
                key: "city".to_owned(),
                value: "Lviv".to_owned(),
                field_type: FieldType::Text,
            }],
        };
        store
            .put_record("contacts", &contact.id.0, &contact)
            .unwrap();
        let link = ChatContactLink {
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            sender_id: "200".to_owned(),
            contact_id: contact.id.clone(),
        };
        let link_id = row_id(&[&link.telegram_user_id, &link.chat_id, &link.sender_id]);
        store
            .put_record("chat_contact_links", &link_id, &link)
            .unwrap();
        let fact = Fact {
            id: FactId("fact-1".to_owned()),
            contact_id: contact.id.clone(),
            kind: FactKind::Note,
            title: "Seats".to_owned(),
            body: "40".to_owned(),
            priority: Priority::High,
            due_at: Some(UnixMillis(40)),
            source: FactSource::Manual,
            confirmed: true,
        };
        store.put_record("facts", &fact.id.0, &fact).unwrap();
        let pin = Pin {
            id: PinId("pin-1".to_owned()),
            contact_id: contact.id.clone(),
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            message_id: "50".to_owned(),
            snapshot: sample_snapshot(),
            note: "price".to_owned(),
        };
        store.put_record("pins", &pin.id.0, &pin).unwrap();
        let template = Template {
            id: TemplateId("template-1".to_owned()),
            scope: TemplateScope::Workspace,
            shortcut: "price".to_owned(),
            body: "Hello {{contact.display_name}}".to_owned(),
        };
        store
            .put_record("templates", &template.id.0, &template)
            .unwrap();
        let follow_up = FollowUp {
            id: FollowUpId("follow-1".to_owned()),
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            due_at: UnixMillis(50),
            note: "nudge".to_owned(),
            template_id: Some(template.id.clone()),
            status: FollowUpStatus::Open,
            auto_send: false,
        };
        store
            .put_record("follow_ups", &follow_up.id.0, &follow_up)
            .unwrap();
        let internal = InternalNote {
            id: InternalNoteId("internal-1".to_owned()),
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            anchor_message_id: "50".to_owned(),
            author: "You".to_owned(),
            body: "only here".to_owned(),
            at: UnixMillis(60),
        };
        store
            .put_record("internal_notes", &internal.id.0, &internal)
            .unwrap();
        let deal = Deal {
            id: DealId("deal-1".to_owned()),
            contact_id: contact.id.clone(),
            title: "40 seats".to_owned(),
            stage: "Working".to_owned(),
            amount_minor: Some(MinorUnits(4000)),
            currency: Some("EUR".to_owned()),
            expected_on: Some(UnixMillis(70)),
            source_message_id: "50".to_owned(),
        };
        store.put_record("deals", &deal.id.0, &deal).unwrap();
        let draft = AiDraft {
            id: crm_chat_core::AiDraftId("draft-1".to_owned()),
            kind: AiDraftKind::Reply,
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            from_message_id: "50".to_owned(),
            to_message_id: "50".to_owned(),
            body: "We can do Friday.".to_owned(),
            endpoint_host: "localhost".to_owned(),
            stayed_on_machine: true,
            accepted: false,
        };
        store.put_record("ai_drafts", &draft.id.0, &draft).unwrap();
        let member = Member {
            id: MemberId("member-2".to_owned()),
            display_name: "Assistant".to_owned(),
            role: MemberRole::Member,
            credential_hash: "member-credential".to_owned(),
            revoked: false,
        };
        store.put_record("members", &member.id.0, &member).unwrap();
        let grant = AccountGrant {
            member_id: member.id.clone(),
            telegram_user_id: "42".to_owned(),
            visibility: AccountVisibility::All,
            send: SendGrant::Reply,
        };
        let grant_id = row_id(&[&grant.member_id.0, &grant.telegram_user_id]);
        store
            .put_record("account_grants", &grant_id, &grant)
            .unwrap();
        let assignment = Assignment {
            id: AssignmentId("assignment-1".to_owned()),
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            assignee_id: member.id.clone(),
            watcher_ids: vec![MemberId(MEMBER_YOU_ID.to_owned())],
            assigned_at: UnixMillis(80),
        };
        store
            .put_record("assignments", &assignment.id.0, &assignment)
            .unwrap();
        let handoff = Handoff {
            id: HandoffId("handoff-1".to_owned()),
            telegram_user_id: "42".to_owned(),
            chat_id: "chat-1".to_owned(),
            from_member_id: MemberId(MEMBER_YOU_ID.to_owned()),
            to_member_id: member.id.clone(),
            note: "take the supplier".to_owned(),
            at: UnixMillis(90),
        };
        store
            .put_record("handoffs", &handoff.id.0, &handoff)
            .unwrap();
        let endpoint = WebhookEndpoint {
            id: WebhookEndpointId("hook-1".to_owned()),
            url: "https://example.invalid/hook".to_owned(),
            secret: "endpoint-secret".to_owned(),
            event_names: vec!["case.closed".to_owned()],
            enabled: false,
        };
        store
            .put_record("webhook_endpoints", &endpoint.id.0, &endpoint)
            .unwrap();
        let delivery = WebhookDelivery {
            id: WebhookDeliveryId("delivery-1".to_owned()),
            endpoint_id: endpoint.id.clone(),
            event: "case.closed".to_owned(),
            status: "pending".to_owned(),
            attempts: 1,
            last_error: String::new(),
        };
        store
            .put_record("webhook_deliveries", &delivery.id.0, &delivery)
            .unwrap();
        let bundle = store.insert_case(olena_draft(), UnixMillis(100)).unwrap();

        assert_eq!(
            store
                .get_record::<Person>("people", "person-olena")
                .unwrap(),
            Some(person)
        );
        assert_eq!(
            store
                .get_record::<AccountLabel>("account_labels", "acct-1")
                .unwrap(),
            Some(label)
        );
        assert_eq!(
            store
                .get_record::<AccountRef>("account_refs", "42")
                .unwrap(),
            Some(account_ref)
        );
        assert_eq!(
            store
                .get_record::<ChatTriage>("chat_triage", &triage_id)
                .unwrap(),
            Some(triage)
        );
        assert_eq!(
            store
                .get_record::<Contact>("contacts", "contact-1")
                .unwrap(),
            Some(contact)
        );
        assert_eq!(
            store
                .get_record::<ChatContactLink>("chat_contact_links", &link_id)
                .unwrap(),
            Some(link)
        );
        assert_eq!(
            store.get_record::<Fact>("facts", "fact-1").unwrap(),
            Some(fact)
        );
        assert_eq!(store.get_record::<Pin>("pins", "pin-1").unwrap(), Some(pin));
        assert_eq!(
            store
                .get_record::<Template>("templates", "template-1")
                .unwrap(),
            Some(template)
        );
        assert_eq!(
            store
                .get_record::<FollowUp>("follow_ups", "follow-1")
                .unwrap(),
            Some(follow_up)
        );
        assert_eq!(
            store
                .get_record::<InternalNote>("internal_notes", "internal-1")
                .unwrap(),
            Some(internal)
        );
        assert_eq!(
            store.get_record::<Deal>("deals", "deal-1").unwrap(),
            Some(deal)
        );
        assert_eq!(
            store.get_record::<AiDraft>("ai_drafts", "draft-1").unwrap(),
            Some(draft)
        );
        assert_eq!(
            store.get_record::<Member>("members", "member-2").unwrap(),
            Some(member)
        );
        assert_eq!(
            store
                .get_record::<AccountGrant>("account_grants", &grant_id)
                .unwrap(),
            Some(grant)
        );
        assert_eq!(
            store
                .get_record::<Assignment>("assignments", "assignment-1")
                .unwrap(),
            Some(assignment)
        );
        assert_eq!(
            store
                .get_record::<Handoff>("handoffs", "handoff-1")
                .unwrap(),
            Some(handoff)
        );
        assert_eq!(
            store
                .get_record::<WebhookEndpoint>("webhook_endpoints", "hook-1")
                .unwrap(),
            Some(endpoint)
        );
        assert_eq!(
            store
                .get_record::<WebhookDelivery>("webhook_deliveries", "delivery-1")
                .unwrap(),
            Some(delivery)
        );
        assert_eq!(bundle.case.number, 1);
        assert_eq!(bundle, store.case_bundle("case-olena").unwrap().unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn login_payload_does_not_leave_api_hash_in_the_file() {
        let dir = temp_dir();
        let path = install_path(&dir);
        let hash = "0123456789abcdef0123456789abcdef";
        let payload = Payload::Map(vec![
            ("api_hash".to_owned(), Payload::Text(hash.to_owned())),
            ("api_id".to_owned(), Payload::Text("42424242".to_owned())),
            (
                "session".to_owned(),
                Payload::Text("session-do-not-store".to_owned()),
            ),
            (
                "access_hash".to_owned(),
                Payload::Text("777000111".to_owned()),
            ),
            ("display_name".to_owned(), Payload::Text("Olena".to_owned())),
        ]);
        let store = Workspace::open(&path).unwrap();
        let row = store
            .record_login("acct-1", "Work", &payload, UnixMillis(1))
            .unwrap();
        assert_eq!(row.label, "Work");
        assert_eq!(row.observed_name, "Olena");
        drop(store);
        let text = file_text(&path);
        assert!(
            !text.contains(hash),
            "api_hash was written into the workspace"
        );
        assert!(!text.contains("42424242"));
        assert!(!text.contains("session-do-not-store"));
        assert!(!text.contains("777000111"));
        assert!(text.contains("Olena"));
        assert!(text.contains("Work"));
        let store = Workspace::open(&path).unwrap();
        store
            .record_login(
                "acct-1",
                "Work",
                &safe_login_payload("acct-1", "Work"),
                UnixMillis(2),
            )
            .unwrap();
        store.remember_account("acct-1", "Work").unwrap();
        drop(store);
        let text = file_text(&path);
        assert!(
            !text.contains(hash),
            "api_hash was written into the workspace"
        );
        assert!(!text.contains("42424242"));
        assert!(!text.contains("session-do-not-store"));
        assert!(!text.contains("777000111"));
        assert!(text.contains("Work"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fixture_case_round_trips_and_numbers_are_not_reused() {
        let dir = temp_dir();
        let mut store = Workspace::open(&install_path(&dir)).unwrap();
        assert_eq!(store.schema_version().unwrap(), 1);
        let stage = store
            .get_record::<crm_chat_core::Stage>("stages", STAGE_WORKING_ID)
            .unwrap()
            .unwrap();
        assert_eq!(stage.name, "Working");
        let bundle = store.insert_case(olena_draft(), UnixMillis(100)).unwrap();
        assert_eq!(bundle.case.number, 1);
        assert_eq!(bundle.case.title, "Olena, 40 seats");
        assert_eq!(bundle.case.kind, CaseKind::Deal);
        assert_eq!(bundle.case.stage_id.0, STAGE_WORKING_ID);
        assert_eq!(bundle.case.priority, Priority::High);
        assert_eq!(bundle.case.due_at, Some(UnixMillis(1_763_337_600_000)));
        assert_eq!(bundle.participants[0].name_snapshot, "Olena");
        assert_eq!(
            bundle.messages[0].snapshot.text,
            "can you do 40 seats by Friday?"
        );
        assert_eq!(bundle.notes[0].body, "Asked the supplier");
        assert_eq!(bundle.events[0].kind, CaseEventKind::Created);
        assert_eq!(
            store.case_ids_for_chat("sales", "sales:olena").unwrap(),
            vec!["case-olena".to_owned()]
        );
        assert_eq!(store.list_open_cases().unwrap().len(), 1);
        let again = store
            .attach_message(bundle.messages[0].clone())
            .unwrap_err();
        assert!(matches!(again, StoreError::DuplicateLink));
        let closed = store
            .close_case("case-olena", CaseOutcome::Won, "shipped", UnixMillis(200))
            .unwrap();
        assert_eq!(closed.number, 1);
        assert_eq!(closed.status, CaseStatus::Closed);
        let mut second = olena_draft();
        second.id = CaseId("case-next".to_owned());
        second.messages[0].message.message_id = "51".to_owned();
        second.notes[0].id = NoteId("note-2".to_owned());
        second.events[0].id = EventId("event-2".to_owned());
        second.files[0].id = FileId("file-2".to_owned());
        second.chats[0].chat.chat_id = ChatId("sales:next".to_owned());
        second.primary_chat.as_mut().unwrap().chat_id = ChatId("sales:next".to_owned());
        let created = store.insert_case(second, UnixMillis(300)).unwrap();
        assert_eq!(created.case.number, 2);
        assert_eq!(
            store
                .case_bundle("case-olena")
                .unwrap()
                .unwrap()
                .case
                .number,
            1
        );
        assert_eq!(
            store.case_bundle("case-olena").unwrap().unwrap().messages[0]
                .snapshot
                .text,
            "can you do 40 seats by Friday?"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn logout_and_account_removal_keep_the_person_and_the_case() {
        let dir = temp_dir();
        let mut store = Workspace::open(&install_path(&dir)).unwrap();
        let person = sample_person();
        store.put_record("people", &person.id.0, &person).unwrap();
        store.insert_case(olena_draft(), UnixMillis(100)).unwrap();
        store
            .record_login(
                "acct-1",
                "Work",
                &safe_login_payload("acct-1", "Work"),
                UnixMillis(1),
            )
            .unwrap();
        store.note_logout("acct-1").unwrap();
        store.note_account_removed("acct-1").unwrap();
        store
            .record_login(
                "acct-2",
                "Personal",
                &safe_login_payload("acct-2", "Personal"),
                UnixMillis(2),
            )
            .unwrap();
        assert_eq!(
            store
                .get_record::<Person>("people", "person-olena")
                .unwrap()
                .unwrap()
                .display_name,
            "Olena"
        );
        let bundle = store.case_bundle("case-olena").unwrap().unwrap();
        assert_eq!(bundle.case.title, "Olena, 40 seats");
        assert_eq!(bundle.messages[0].snapshot.account_label, "Sales");
        let label = store
            .get_record::<AccountLabel>("account_labels", "acct-1")
            .unwrap()
            .unwrap();
        assert_eq!(label.connection, "removed");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_later_migration_keeps_existing_rows() {
        let dir = temp_dir();
        let path = install_path(&dir);
        let store = Workspace::open(&path).unwrap();
        store
            .put_record("people", "person-olena", &sample_person())
            .unwrap();
        drop(store);
        let mut steps = production_steps();
        steps.push(Step {
            version: 2,
            apply: |conn| {
                conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS migration_probe (id INTEGER PRIMARY KEY);",
                )?;
                Ok(())
            },
        });
        let store = Workspace::open_at(&path, &steps, 2).unwrap();
        assert_eq!(store.schema_version().unwrap(), 2);
        assert_eq!(
            store
                .get_record::<Person>("people", "person-olena")
                .unwrap()
                .unwrap()
                .display_name,
            "Olena"
        );
        drop(store);
        match Workspace::open(&path) {
            Err(StoreError::NewerSchema { found: 2 }) => {}
            Err(error) => panic!("expected a newer schema, got {error}"),
            Ok(_) => panic!("opened a schema this build does not know"),
        }
        assert!(file_text(&path).contains("Olena"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn sample_snapshot() -> MessageSnapshot {
        MessageSnapshot {
            text: "can you do 40 seats by Friday?".to_owned(),
            sent_at: UnixMillis(1_763_000_000_000),
            sender_name: "Olena".to_owned(),
            sender_user_id: "200".to_owned(),
            outgoing: false,
            media_kind: MediaKind::None,
            chat_title: "Olena".to_owned(),
            account_label: "Sales".to_owned(),
        }
    }

    fn olena_draft() -> CaseDraft {
        let case_id = CaseId("case-olena".to_owned());
        let chat = MessageRef {
            account_id: "sales".to_owned(),
            chat_id: ChatId("sales:olena".to_owned()),
            telegram_chat_id: "100".to_owned(),
            message_id: String::new(),
            message_thread_id: "0".to_owned(),
        };
        let mut message_ref = chat.clone();
        message_ref.message_id = "50".to_owned();
        CaseDraft {
            id: case_id.clone(),
            title: "  Olena, 40 seats  ".to_owned(),
            kind: CaseKind::Deal,
            stage_id: StageId(STAGE_WORKING_ID.to_owned()),
            priority: Priority::High,
            owner_id: MEMBER_YOU_ID.to_owned(),
            due_at: Some(UnixMillis(1_763_337_600_000)),
            follow_up_at: Some(UnixMillis(1_763_400_000_000)),
            reply_account_id: "sales".to_owned(),
            primary_chat: Some(chat.clone()),
            chats: vec![CaseChat {
                case_id: case_id.clone(),
                chat,
                role: CaseRole::Primary,
                title_snapshot: "Olena".to_owned(),
                account_label_snapshot: "Sales".to_owned(),
            }],
            participants: vec![CaseParticipant {
                case_id: case_id.clone(),
                telegram_user_id: "200".to_owned(),
                role: CaseRole::Primary,
                name_snapshot: "Olena".to_owned(),
                username_snapshot: "olena".to_owned(),
            }],
            messages: vec![CaseMessage {
                case_id: case_id.clone(),
                message: message_ref,
                attached_at: UnixMillis(1_763_000_000_000),
                attached_by: MEMBER_YOU_ID.to_owned(),
                snapshot: MessageSnapshot {
                    text: "  can you do 40 seats by Friday?  ".to_owned(),
                    ..sample_snapshot()
                },
            }],
            notes: vec![CaseNote {
                id: NoteId("note-1".to_owned()),
                case_id: case_id.clone(),
                body: "Asked the supplier".to_owned(),
                created_at: UnixMillis(1_763_100_000_000),
                author_id: MEMBER_YOU_ID.to_owned(),
                source: None,
            }],
            files: vec![CaseFile {
                id: FileId("file-1".to_owned()),
                case_id: case_id.clone(),
                added_at: UnixMillis(1_763_200_000_000),
                name: "price.pdf".to_owned(),
                byte_length: ByteLength(12),
                media_type: "application/pdf".to_owned(),
                source_kind: FileSourceKind::Local,
                source: None,
                relative_path: "price.pdf".to_owned(),
            }],
            events: vec![CaseEvent {
                id: EventId("event-1".to_owned()),
                case_id,
                at: UnixMillis(1_763_000_000_000),
                kind: CaseEventKind::Created,
                from_id: String::new(),
                to_id: STAGE_WORKING_ID.to_owned(),
                from_name: String::new(),
                to_name: "Working".to_owned(),
                quote: String::new(),
                outcome: CaseOutcome::None,
                stage_id: STAGE_WORKING_ID.to_owned(),
                stage_name: "Working".to_owned(),
                follow_up_at: None,
            }],
        }
    }
}
