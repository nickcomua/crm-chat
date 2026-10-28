use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, TS)]
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
    use super::{Chat, ChatId, ChatKind};
    use std::path::PathBuf;
    use ts_rs::TS;

    fn committed_types_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/src/generated/core.ts")
    }

    fn generated_types() -> String {
        let cfg = ts_rs::Config::new();
        format!(
            "export {}\n\nexport {}\n\nexport {}\n",
            ChatId::decl(&cfg),
            ChatKind::decl(&cfg),
            Chat::decl(&cfg),
        )
    }

    #[test]
    fn committed_types_match_the_core() {
        let path = committed_types_path();
        let committed = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        let generated = generated_types();
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
        let source = include_str!("lib.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap_or("");
        for banned in [
            "tokio",
            "tungstenite",
            "grammers",
            "websocket",
            "mio",
            "std::net",
            "TcpStream",
        ] {
            assert!(
                !manifest.contains(banned) && !source.contains(banned),
                "core must not contain {banned}"
            );
        }
    }
}
