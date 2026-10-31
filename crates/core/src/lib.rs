mod crm;
mod schema;
mod scrub;

pub use crm::*;
pub use schema::*;
pub use scrub::*;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(type = "string")]
pub struct ChatId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, TS)]
pub enum ChatKind {
    Dialog,
    Group,
    Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, TS)]
pub struct Chat {
    pub id: ChatId,
    pub title: String,
    pub kind: ChatKind,
}

#[cfg(test)]
mod generated_types {
    use super::{
        AccountGrant, AccountLabel, AccountRef, AccountVisibility, AiDraft, AiDraftId, AiDraftKind,
        Assignment, AssignmentId, ByteLength, Case, CaseBundle, CaseChat, CaseDraft, CaseEvent,
        CaseEventKind, CaseFile, CaseId, CaseKind, CaseMessage, CaseNote, CaseOutcome,
        CaseParticipant, CaseRole, CaseStatus, Chat, ChatContactLink, ChatId, ChatKind, ChatTriage,
        Contact, ContactId, CustomField, Deal, DealId, EventId, Fact, FactId, FactKind, FactSource,
        FieldType, FileId, FileSourceKind, FollowUp, FollowUpId, FollowUpStatus, Handoff,
        HandoffId, InternalNote, InternalNoteId, MediaKind, Member, MemberId, MemberRole,
        MessageRef, MessageSnapshot, MinorUnits, NoteId, Person, PersonId, Pin, PinId, Priority,
        SendGrant, Stage, StageId, Template, TemplateId, TemplateScope, UnixMillis,
        WebhookDelivery, WebhookDeliveryId, WebhookEndpoint, WebhookEndpointId, SCHEMA_VERSION,
        SECRET_FIELD_NAMES,
    };
    use std::path::PathBuf;
    use ts_rs::TS;

    fn committed_types_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/src/generated/core.ts")
    }

    fn export_decl<T: TS>(cfg: &ts_rs::Config) -> String {
        format!("export {}\n", T::decl(cfg))
    }

    fn generated_types() -> String {
        let cfg = ts_rs::Config::new();
        let mut body = String::new();
        let decls = [
            export_decl::<ChatId>(&cfg),
            export_decl::<ChatKind>(&cfg),
            export_decl::<Chat>(&cfg),
            export_decl::<UnixMillis>(&cfg),
            export_decl::<MinorUnits>(&cfg),
            export_decl::<ByteLength>(&cfg),
            export_decl::<PersonId>(&cfg),
            export_decl::<CaseId>(&cfg),
            export_decl::<StageId>(&cfg),
            export_decl::<MemberId>(&cfg),
            export_decl::<NoteId>(&cfg),
            export_decl::<FileId>(&cfg),
            export_decl::<EventId>(&cfg),
            export_decl::<ContactId>(&cfg),
            export_decl::<FactId>(&cfg),
            export_decl::<PinId>(&cfg),
            export_decl::<TemplateId>(&cfg),
            export_decl::<FollowUpId>(&cfg),
            export_decl::<InternalNoteId>(&cfg),
            export_decl::<DealId>(&cfg),
            export_decl::<AiDraftId>(&cfg),
            export_decl::<WebhookEndpointId>(&cfg),
            export_decl::<WebhookDeliveryId>(&cfg),
            export_decl::<AssignmentId>(&cfg),
            export_decl::<HandoffId>(&cfg),
            export_decl::<FieldType>(&cfg),
            export_decl::<CustomField>(&cfg),
            export_decl::<FactKind>(&cfg),
            export_decl::<FactSource>(&cfg),
            export_decl::<TemplateScope>(&cfg),
            export_decl::<FollowUpStatus>(&cfg),
            export_decl::<MemberRole>(&cfg),
            export_decl::<AccountVisibility>(&cfg),
            export_decl::<SendGrant>(&cfg),
            export_decl::<AiDraftKind>(&cfg),
            export_decl::<CaseKind>(&cfg),
            export_decl::<CaseStatus>(&cfg),
            export_decl::<CaseOutcome>(&cfg),
            export_decl::<Priority>(&cfg),
            export_decl::<CaseRole>(&cfg),
            export_decl::<MediaKind>(&cfg),
            export_decl::<CaseEventKind>(&cfg),
            export_decl::<FileSourceKind>(&cfg),
            export_decl::<Person>(&cfg),
            export_decl::<AccountLabel>(&cfg),
            export_decl::<AccountRef>(&cfg),
            export_decl::<ChatTriage>(&cfg),
            export_decl::<Contact>(&cfg),
            export_decl::<ChatContactLink>(&cfg),
            export_decl::<Fact>(&cfg),
            export_decl::<MessageSnapshot>(&cfg),
            export_decl::<Pin>(&cfg),
            export_decl::<Template>(&cfg),
            export_decl::<FollowUp>(&cfg),
            export_decl::<InternalNote>(&cfg),
            export_decl::<Deal>(&cfg),
            export_decl::<AiDraft>(&cfg),
            export_decl::<Member>(&cfg),
            export_decl::<AccountGrant>(&cfg),
            export_decl::<Assignment>(&cfg),
            export_decl::<Handoff>(&cfg),
            export_decl::<WebhookEndpoint>(&cfg),
            export_decl::<WebhookDelivery>(&cfg),
            export_decl::<Stage>(&cfg),
            export_decl::<MessageRef>(&cfg),
            export_decl::<Case>(&cfg),
            export_decl::<CaseChat>(&cfg),
            export_decl::<CaseParticipant>(&cfg),
            export_decl::<CaseMessage>(&cfg),
            export_decl::<CaseNote>(&cfg),
            export_decl::<CaseFile>(&cfg),
            export_decl::<CaseEvent>(&cfg),
            export_decl::<CaseBundle>(&cfg),
            export_decl::<CaseDraft>(&cfg),
        ];
        for decl in decls {
            body.push_str(&decl);
            body.push('\n');
        }
        let secrets = SECRET_FIELD_NAMES
            .iter()
            .map(|name| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ");
        body.push_str(&format!(
            "export const SCHEMA_VERSION = {SCHEMA_VERSION};\n\nexport const DESKTOP_WORKSPACE_FILE = \"{}\";\n\nexport const WEB_WORKSPACE_DATABASE = \"{}\";\n\nexport const STAGE_NEW_ID = \"{}\";\n\nexport const STAGE_WORKING_ID = \"{}\";\n\nexport const STAGE_WAITING_ID = \"{}\";\n\nexport const STAGE_READY_ID = \"{}\";\n\nexport const MEMBER_YOU_ID = \"{}\";\n\nexport const MEMBER_YOU_NAME = \"{}\";\n\nexport const SECRET_FIELD_NAMES = [{secrets}] as const;\n",
            super::DESKTOP_WORKSPACE_FILE,
            super::WEB_WORKSPACE_DATABASE,
            super::STAGE_NEW_ID,
            super::STAGE_WORKING_ID,
            super::STAGE_WAITING_ID,
            super::STAGE_READY_ID,
            super::MEMBER_YOU_ID,
            super::MEMBER_YOU_NAME,
        ));
        body
    }

    #[test]
    fn committed_types_match_the_core() {
        let path = committed_types_path();
        let generated = generated_types();
        if std::env::var_os("CRM_CHAT_UPDATE_CORE_TS").is_some() {
            std::fs::write(&path, &generated).unwrap();
        }
        let committed = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        assert_eq!(
            committed,
            generated,
            "generated types are stale; replace {} with the core export",
            path.display()
        );
    }

    #[test]
    fn core_has_no_socket_crates() {
        let manifest = include_str!("../Cargo.toml");
        let mut source = String::new();
        for name in ["lib.rs", "crm.rs", "schema.rs", "scrub.rs"] {
            let text = match name {
                "lib.rs" => include_str!("lib.rs"),
                "crm.rs" => include_str!("crm.rs"),
                "schema.rs" => include_str!("schema.rs"),
                "scrub.rs" => include_str!("scrub.rs"),
                _ => "",
            };
            source.push_str(text.split("#[cfg(test)]").next().unwrap_or(""));
        }
        for banned in [
            "tokio",
            "tungstenite",
            "grammers",
            "websocket",
            "mio",
            "std::net",
            "TcpStream",
            "rusqlite",
            "sqlx",
        ] {
            assert!(
                !manifest.contains(banned) && !source.contains(banned),
                "core must not contain {banned}"
            );
        }
    }

    #[test]
    fn schema_starts_at_one_and_shells_do_not_share_a_file() {
        assert_eq!(super::SCHEMA_VERSION, 1);
        assert_ne!(super::DESKTOP_WORKSPACE_FILE, super::WEB_WORKSPACE_DATABASE);
        assert_ne!(super::DESKTOP_WORKSPACE_FILE, "cases.sqlite");
        assert_ne!(super::WEB_WORKSPACE_DATABASE, "crm-chat-cases");
    }

    #[test]
    fn case_numbers_start_at_one_and_are_not_reused() {
        assert_eq!(super::next_case_number([]), 1);
        assert_eq!(super::next_case_number([1, 2]), 3);
        assert_eq!(super::next_case_number([1]), 2);
    }

    #[test]
    fn case_title_is_trimmed_and_bounded() {
        assert_eq!(super::require_case_title("  Olena  ").unwrap(), "Olena");
        assert!(super::require_case_title("   ").is_err());
        assert!(super::require_case_title(&"a".repeat(121)).is_err());
        assert_eq!(super::require_snapshot_text("  hi ").unwrap(), "hi");
        assert!(super::require_snapshot_text(&"a".repeat(501)).is_err());
    }

    #[test]
    fn adapter_payload_drops_secrets() {
        let hash = "0123456789abcdef0123456789abcdef";
        let payload = super::Payload::Map(vec![
            ("api_hash".to_owned(), super::Payload::Text(hash.to_owned())),
            (
                "apiId".to_owned(),
                super::Payload::Text("42424242".to_owned()),
            ),
            (
                "session_string".to_owned(),
                super::Payload::Text("session-do-not-store".to_owned()),
            ),
            (
                "access_hash".to_owned(),
                super::Payload::Text("777000111".to_owned()),
            ),
            (
                "display_name".to_owned(),
                super::Payload::Text("Olena".to_owned()),
            ),
            ("label".to_owned(), super::Payload::Text(hash.to_owned())),
        ]);
        let record = super::login_record("acct-1", "Work", &payload);
        let rendered = format!("{record:?}{:?}", super::scrub_payload(&payload));
        assert_eq!(record.account_id, "acct-1");
        assert_eq!(record.label, "Work");
        assert_eq!(record.observed_name, "Olena");
        assert!(!rendered.contains(hash));
        assert!(!rendered.contains("42424242"));
        assert!(!rendered.contains("session-do-not-store"));
        assert!(!rendered.contains("777000111"));
        let safe = super::safe_login_payload("acct-1", "Work");
        assert!(!format!("{safe:?}").contains("api_hash"));
    }
}
