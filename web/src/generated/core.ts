export type ChatId = string;

export type ChatKind = "Dialog" | "Group" | "Channel";

export type Chat = { id: ChatId, title: string, kind: ChatKind, };

export type UnixMillis = number;

export type MinorUnits = number;

export type ByteLength = number;

export type PersonId = string;

export type CaseId = string;

export type StageId = string;

export type MemberId = string;

export type NoteId = string;

export type FileId = string;

export type EventId = string;

export type ContactId = string;

export type FactId = string;

export type PinId = string;

export type TemplateId = string;

export type FollowUpId = string;

export type InternalNoteId = string;

export type DealId = string;

export type AiDraftId = string;

export type WebhookEndpointId = string;

export type WebhookDeliveryId = string;

export type AssignmentId = string;

export type HandoffId = string;

export type FieldType = "Text" | "Number" | "Date" | "Email" | "Phone" | "Url";

export type CustomField = { key: string, value: string, field_type: FieldType, };

export type FactKind = "Note" | "Knowledge" | "Task" | "Link" | "Date";

export type FactSource = "Manual" | "Message" | "Ai";

export type TemplateScope = "Workspace" | "Account";

export type FollowUpStatus = "Open" | "Done" | "Cancelled";

export type MemberRole = "Owner" | "Admin" | "Member" | "Viewer";

export type AccountVisibility = "Hidden" | "Assigned" | "All";

export type SendGrant = "None" | "Reply";

export type AiDraftKind = "Summary" | "Reply" | "Extraction";

export type CaseKind = "Request" | "Deal";

export type CaseStatus = "Open" | "Closed";

export type CaseOutcome = "None" | "Won" | "Resolved" | "Lost" | "Dropped";

export type Priority = "Low" | "Normal" | "High" | "Urgent";

export type CaseRole = "Primary" | "Related";

export type MediaKind = "None" | "Photo" | "Video" | "VideoNote" | "Voice" | "Audio" | "File" | "Sticker" | "Animation" | "Other";

export type CaseEventKind = "Created" | "StageChanged" | "PriorityChanged" | "DueChanged" | "OwnerChanged" | "TitleChanged" | "KindChanged" | "FollowUpSet" | "FollowUpCleared" | "FollowUpSnoozed" | "MessageAttached" | "MessageDetached" | "NoteAdded" | "FileAdded" | "ParticipantAdded" | "ParticipantRemoved" | "ChatLinked" | "ChatUnlinked" | "Closed" | "Reopened";

export type FileSourceKind = "Telegram" | "Local";

export type Person = { id: PersonId, display_name: string, name_overridden: boolean, created_at: UnixMillis, updated_at: UnixMillis, pinned_in_people: boolean, };

export type AccountLabel = { account_id: string, label: string, updated_at: UnixMillis, observed_name: string, connection: string, };

export type AccountRef = { telegram_user_id: string, title: string, color: string, connection: string, };

export type ChatTriage = { telegram_user_id: string, chat_id: string, done_through_message_id: string, snoozed_until: UnixMillis | null, manually_flagged: boolean, };

export type Contact = { id: ContactId, display_name: string, notes: string, custom_fields: Array<CustomField>, };

export type ChatContactLink = { telegram_user_id: string, chat_id: string, sender_id: string, contact_id: ContactId, };

export type Fact = { id: FactId, contact_id: ContactId, kind: FactKind, title: string, body: string, priority: Priority, due_at: UnixMillis | null, source: FactSource, confirmed: boolean, };

export type MessageSnapshot = { text: string, sent_at: UnixMillis, sender_name: string, sender_user_id: string, outgoing: boolean, media_kind: MediaKind, chat_title: string, account_label: string, };

export type Pin = { id: PinId, contact_id: ContactId, telegram_user_id: string, chat_id: string, message_id: string, snapshot: MessageSnapshot, note: string, };

export type Template = { id: TemplateId, scope: TemplateScope, shortcut: string, body: string, };

export type FollowUp = { id: FollowUpId, telegram_user_id: string, chat_id: string, due_at: UnixMillis, note: string, template_id: TemplateId | null, status: FollowUpStatus, auto_send: boolean, };

export type InternalNote = { id: InternalNoteId, telegram_user_id: string, chat_id: string, anchor_message_id: string, author: string, body: string, at: UnixMillis, };

export type Deal = { id: DealId, contact_id: ContactId, title: string, stage: string, amount_minor: MinorUnits | null, currency: string | null, expected_on: UnixMillis | null, source_message_id: string, };

export type AiDraft = { id: AiDraftId, kind: AiDraftKind, telegram_user_id: string, chat_id: string, from_message_id: string, to_message_id: string, body: string, endpoint_host: string, stayed_on_machine: boolean, accepted: boolean, };

export type Member = { id: MemberId, display_name: string, role: MemberRole, credential_hash: string, revoked: boolean, };

export type AccountGrant = { member_id: MemberId, telegram_user_id: string, visibility: AccountVisibility, send: SendGrant, };

export type Assignment = { id: AssignmentId, telegram_user_id: string, chat_id: string, assignee_id: MemberId, watcher_ids: Array<MemberId>, assigned_at: UnixMillis, };

export type Handoff = { id: HandoffId, telegram_user_id: string, chat_id: string, from_member_id: MemberId, to_member_id: MemberId, note: string, at: UnixMillis, };

export type WebhookEndpoint = { id: WebhookEndpointId, url: string, secret: string, event_names: Array<string>, enabled: boolean, };

export type WebhookDelivery = { id: WebhookDeliveryId, endpoint_id: WebhookEndpointId, event: string, status: string, attempts: number, last_error: string, };

export type Stage = { id: StageId, name: string, color: string, order: number, };

export type MessageRef = { account_id: string, chat_id: ChatId, telegram_chat_id: string, message_id: string, message_thread_id: string, };

export type Case = { id: CaseId, number: number, title: string, kind: CaseKind, status: CaseStatus, stage_id: StageId, outcome: CaseOutcome, outcome_note: string, amount_minor: MinorUnits | null, currency: string | null, priority: Priority, owner_id: string, due_at: UnixMillis | null, follow_up_at: UnixMillis | null, reply_account_id: string, primary_chat: MessageRef | null, created_at: UnixMillis, updated_at: UnixMillis, closed_at: UnixMillis | null, last_opened_at: UnixMillis | null, };

export type CaseChat = { case_id: CaseId, chat: MessageRef, role: CaseRole, title_snapshot: string, account_label_snapshot: string, };

export type CaseParticipant = { case_id: CaseId, telegram_user_id: string, role: CaseRole, name_snapshot: string, username_snapshot: string, };

export type CaseMessage = { case_id: CaseId, message: MessageRef, attached_at: UnixMillis, attached_by: string, snapshot: MessageSnapshot, };

export type CaseNote = { id: NoteId, case_id: CaseId, body: string, created_at: UnixMillis, author_id: string, source: MessageRef | null, };

export type CaseFile = { id: FileId, case_id: CaseId, added_at: UnixMillis, name: string, byte_length: ByteLength, media_type: string, source_kind: FileSourceKind, source: MessageRef | null, relative_path: string, };

export type CaseEvent = { id: EventId, case_id: CaseId, at: UnixMillis, kind: CaseEventKind, from_id: string, to_id: string, from_name: string, to_name: string, quote: string, outcome: CaseOutcome, stage_id: string, stage_name: string, follow_up_at: UnixMillis | null, };

export type CaseBundle = { case: Case, chats: Array<CaseChat>, participants: Array<CaseParticipant>, messages: Array<CaseMessage>, notes: Array<CaseNote>, files: Array<CaseFile>, events: Array<CaseEvent>, };

export type CaseDraft = { id: CaseId, title: string, kind: CaseKind, stage_id: StageId, priority: Priority, owner_id: string, due_at: UnixMillis | null, follow_up_at: UnixMillis | null, reply_account_id: string, primary_chat: MessageRef | null, chats: Array<CaseChat>, participants: Array<CaseParticipant>, messages: Array<CaseMessage>, notes: Array<CaseNote>, files: Array<CaseFile>, events: Array<CaseEvent>, };

export const SCHEMA_VERSION = 1;

export const DESKTOP_WORKSPACE_FILE = "workspace.sqlite";

export const WEB_WORKSPACE_DATABASE = "crm-chat-workspace";

export const STAGE_NEW_ID = "stage-new";

export const STAGE_WORKING_ID = "stage-working";

export const STAGE_WAITING_ID = "stage-waiting";

export const STAGE_READY_ID = "stage-ready";

export const MEMBER_YOU_ID = "member-you";

export const MEMBER_YOU_NAME = "You";

export const SECRET_FIELD_NAMES = ["api_hash", "api_id", "session", "session_string", "access_hash", "phone_code", "authorization_key", "auth_key", "database_encryption_key", "cloud_password", "password", "password_hash"] as const;
