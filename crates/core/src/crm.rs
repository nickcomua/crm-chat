use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::schema::{
    MEMBER_YOU_ID, MEMBER_YOU_NAME, STAGE_NEW_ID, STAGE_READY_ID, STAGE_WAITING_ID,
    STAGE_WORKING_ID,
};
use crate::ChatId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(type = "number")]
pub struct UnixMillis(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(type = "number")]
pub struct MinorUnits(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(type = "number")]
pub struct ByteLength(pub u64);

macro_rules! string_id {
    ($($name:ident),* $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
        #[ts(type = "string")]
        pub struct $name(pub String);
    )*};
}

string_id!(
    PersonId,
    CaseId,
    StageId,
    MemberId,
    NoteId,
    FileId,
    EventId,
    ContactId,
    FactId,
    PinId,
    TemplateId,
    FollowUpId,
    InternalNoteId,
    DealId,
    AiDraftId,
    WebhookEndpointId,
    WebhookDeliveryId,
    AssignmentId,
    HandoffId,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum FieldType {
    Text,
    Number,
    Date,
    Email,
    Phone,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CustomField {
    pub key: String,
    pub value: String,
    pub field_type: FieldType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum FactKind {
    Note,
    Knowledge,
    Task,
    Link,
    Date,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum FactSource {
    Manual,
    Message,
    Ai,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum TemplateScope {
    Workspace,
    Account,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum FollowUpStatus {
    Open,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MemberRole {
    Owner,
    Admin,
    Member,
    Viewer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum AccountVisibility {
    Hidden,
    Assigned,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum SendGrant {
    None,
    Reply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum AiDraftKind {
    Summary,
    Reply,
    Extraction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum CaseKind {
    Request,
    Deal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum CaseStatus {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum CaseOutcome {
    None,
    Won,
    Resolved,
    Lost,
    Dropped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum Priority {
    Low,
    Normal,
    High,
    Urgent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum CaseRole {
    Primary,
    Related,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MediaKind {
    None,
    Photo,
    Video,
    VideoNote,
    Voice,
    Audio,
    File,
    Sticker,
    Animation,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum CaseEventKind {
    Created,
    StageChanged,
    PriorityChanged,
    DueChanged,
    OwnerChanged,
    TitleChanged,
    KindChanged,
    FollowUpSet,
    FollowUpCleared,
    FollowUpSnoozed,
    MessageAttached,
    MessageDetached,
    NoteAdded,
    FileAdded,
    ParticipantAdded,
    ParticipantRemoved,
    ChatLinked,
    ChatUnlinked,
    Closed,
    Reopened,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum FileSourceKind {
    Telegram,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Person {
    pub id: PersonId,
    pub display_name: String,
    pub name_overridden: bool,
    pub created_at: UnixMillis,
    pub updated_at: UnixMillis,
    pub pinned_in_people: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AccountLabel {
    pub account_id: String,
    pub label: String,
    pub updated_at: UnixMillis,
    pub observed_name: String,
    pub connection: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AccountRef {
    pub telegram_user_id: String,
    pub title: String,
    pub color: String,
    pub connection: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ChatTriage {
    pub telegram_user_id: String,
    pub chat_id: String,
    pub done_through_message_id: String,
    pub snoozed_until: Option<UnixMillis>,
    pub manually_flagged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Contact {
    pub id: ContactId,
    pub display_name: String,
    pub notes: String,
    pub custom_fields: Vec<CustomField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ChatContactLink {
    pub telegram_user_id: String,
    pub chat_id: String,
    pub sender_id: String,
    pub contact_id: ContactId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Fact {
    pub id: FactId,
    pub contact_id: ContactId,
    pub kind: FactKind,
    pub title: String,
    pub body: String,
    pub priority: Priority,
    pub due_at: Option<UnixMillis>,
    pub source: FactSource,
    pub confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct MessageSnapshot {
    pub text: String,
    pub sent_at: UnixMillis,
    pub sender_name: String,
    pub sender_user_id: String,
    pub outgoing: bool,
    pub media_kind: MediaKind,
    pub chat_title: String,
    pub account_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Pin {
    pub id: PinId,
    pub contact_id: ContactId,
    pub telegram_user_id: String,
    pub chat_id: String,
    pub message_id: String,
    pub snapshot: MessageSnapshot,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Template {
    pub id: TemplateId,
    pub scope: TemplateScope,
    pub shortcut: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct FollowUp {
    pub id: FollowUpId,
    pub telegram_user_id: String,
    pub chat_id: String,
    pub due_at: UnixMillis,
    pub note: String,
    pub template_id: Option<TemplateId>,
    pub status: FollowUpStatus,
    pub auto_send: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct InternalNote {
    pub id: InternalNoteId,
    pub telegram_user_id: String,
    pub chat_id: String,
    pub anchor_message_id: String,
    pub author: String,
    pub body: String,
    pub at: UnixMillis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Deal {
    pub id: DealId,
    pub contact_id: ContactId,
    pub title: String,
    pub stage: String,
    pub amount_minor: Option<MinorUnits>,
    pub currency: Option<String>,
    pub expected_on: Option<UnixMillis>,
    pub source_message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AiDraft {
    pub id: AiDraftId,
    pub kind: AiDraftKind,
    pub telegram_user_id: String,
    pub chat_id: String,
    pub from_message_id: String,
    pub to_message_id: String,
    pub body: String,
    pub endpoint_host: String,
    pub stayed_on_machine: bool,
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Member {
    pub id: MemberId,
    pub display_name: String,
    pub role: MemberRole,
    pub credential_hash: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AccountGrant {
    pub member_id: MemberId,
    pub telegram_user_id: String,
    pub visibility: AccountVisibility,
    pub send: SendGrant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Assignment {
    pub id: AssignmentId,
    pub telegram_user_id: String,
    pub chat_id: String,
    pub assignee_id: MemberId,
    pub watcher_ids: Vec<MemberId>,
    pub assigned_at: UnixMillis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Handoff {
    pub id: HandoffId,
    pub telegram_user_id: String,
    pub chat_id: String,
    pub from_member_id: MemberId,
    pub to_member_id: MemberId,
    pub note: String,
    pub at: UnixMillis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct WebhookEndpoint {
    pub id: WebhookEndpointId,
    pub url: String,
    pub secret: String,
    pub event_names: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct WebhookDelivery {
    pub id: WebhookDeliveryId,
    pub endpoint_id: WebhookEndpointId,
    pub event: String,
    pub status: String,
    pub attempts: u32,
    pub last_error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Stage {
    pub id: StageId,
    pub name: String,
    pub color: String,
    pub order: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct MessageRef {
    pub account_id: String,
    pub chat_id: ChatId,
    pub telegram_chat_id: String,
    pub message_id: String,
    pub message_thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Case {
    pub id: CaseId,
    pub number: u32,
    pub title: String,
    pub kind: CaseKind,
    pub status: CaseStatus,
    pub stage_id: StageId,
    pub outcome: CaseOutcome,
    pub outcome_note: String,
    pub amount_minor: Option<MinorUnits>,
    pub currency: Option<String>,
    pub priority: Priority,
    pub owner_id: String,
    pub due_at: Option<UnixMillis>,
    pub follow_up_at: Option<UnixMillis>,
    pub reply_account_id: String,
    pub primary_chat: Option<MessageRef>,
    pub created_at: UnixMillis,
    pub updated_at: UnixMillis,
    pub closed_at: Option<UnixMillis>,
    pub last_opened_at: Option<UnixMillis>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseChat {
    pub case_id: CaseId,
    pub chat: MessageRef,
    pub role: CaseRole,
    pub title_snapshot: String,
    pub account_label_snapshot: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseParticipant {
    pub case_id: CaseId,
    pub telegram_user_id: String,
    pub role: CaseRole,
    pub name_snapshot: String,
    pub username_snapshot: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseMessage {
    pub case_id: CaseId,
    pub message: MessageRef,
    pub attached_at: UnixMillis,
    pub attached_by: String,
    pub snapshot: MessageSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseNote {
    pub id: NoteId,
    pub case_id: CaseId,
    pub body: String,
    pub created_at: UnixMillis,
    pub author_id: String,
    pub source: Option<MessageRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseFile {
    pub id: FileId,
    pub case_id: CaseId,
    pub added_at: UnixMillis,
    pub name: String,
    pub byte_length: ByteLength,
    pub media_type: String,
    pub source_kind: FileSourceKind,
    pub source: Option<MessageRef>,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseEvent {
    pub id: EventId,
    pub case_id: CaseId,
    pub at: UnixMillis,
    pub kind: CaseEventKind,
    pub from_id: String,
    pub to_id: String,
    pub from_name: String,
    pub to_name: String,
    pub quote: String,
    pub outcome: CaseOutcome,
    pub stage_id: String,
    pub stage_name: String,
    pub follow_up_at: Option<UnixMillis>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseBundle {
    pub case: Case,
    pub chats: Vec<CaseChat>,
    pub participants: Vec<CaseParticipant>,
    pub messages: Vec<CaseMessage>,
    pub notes: Vec<CaseNote>,
    pub files: Vec<CaseFile>,
    pub events: Vec<CaseEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CaseDraft {
    pub id: CaseId,
    pub title: String,
    pub kind: CaseKind,
    pub stage_id: StageId,
    pub priority: Priority,
    pub owner_id: String,
    pub due_at: Option<UnixMillis>,
    pub follow_up_at: Option<UnixMillis>,
    pub reply_account_id: String,
    pub primary_chat: Option<MessageRef>,
    pub chats: Vec<CaseChat>,
    pub participants: Vec<CaseParticipant>,
    pub messages: Vec<CaseMessage>,
    pub notes: Vec<CaseNote>,
    pub files: Vec<CaseFile>,
    pub events: Vec<CaseEvent>,
}

pub fn seeded_stages() -> [Stage; 4] {
    [
        Stage {
            id: StageId(STAGE_NEW_ID.to_owned()),
            name: "New".to_owned(),
            color: "blue".to_owned(),
            order: 0,
        },
        Stage {
            id: StageId(STAGE_WORKING_ID.to_owned()),
            name: "Working".to_owned(),
            color: "violet".to_owned(),
            order: 1,
        },
        Stage {
            id: StageId(STAGE_WAITING_ID.to_owned()),
            name: "Waiting".to_owned(),
            color: "orange".to_owned(),
            order: 2,
        },
        Stage {
            id: StageId(STAGE_READY_ID.to_owned()),
            name: "Ready".to_owned(),
            color: "green".to_owned(),
            order: 3,
        },
    ]
}

pub fn seeded_member() -> Member {
    Member {
        id: MemberId(MEMBER_YOU_ID.to_owned()),
        display_name: MEMBER_YOU_NAME.to_owned(),
        role: MemberRole::Owner,
        credential_hash: String::new(),
        revoked: false,
    }
}

pub fn same_case_message(left: &CaseMessage, right: &CaseMessage) -> bool {
    left.case_id == right.case_id
        && left.message.account_id == right.message.account_id
        && left.message.chat_id == right.message.chat_id
        && left.message.message_id == right.message.message_id
}

pub fn row_id(parts: &[&str]) -> String {
    parts.join("\u{1f}")
}
