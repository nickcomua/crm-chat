# Share one Rust core

Status: confirmed design, with local x86_64-linux verification completed. aarch64-linux is evaluated, not built. GitHub CI has not been run.

Interview record for [KAM-41](https://linear.app/kaminazuma/issue/KAM-41/share-one-rust-core-that-compiles-native-and-to-wasm). Parent design: [KAM-39](https://linear.app/kaminazuma/issue/KAM-39/plan-a-refactor). Shell boot: [boot-shells.md](boot-shells.md).

## Accepted

- The core compiles for Linux and wasm32. TypeScript types are generated from it. The web shell does not instantiate WASM. The desktop shell does not call native Rust. Fixture values live in the web shell and are checked against the generated types. The core exports types only: no fixture function and no chat-list API.
- The desktop shell shows the fixture because it opens the same page. It does not depend on the core in this ticket.
- wasm32 acceptance is that the core compiles for wasm32. This ticket does not publish a browser module. The core does not depend on grammers or any socket crate.
- The fixture is one dialog, one group, and one channel, in one list. Each row shows the title and the kind, and nothing else. No unread count, preview, time, avatar, pin, mute, or account. No sort and no kind sections.
- Those chat-list types are the ones later tickets fill. They are not a throwaway sketch. Later tickets may add fields. They do not replace the three kinds or the chat id.
- Dialog is a private chat, including the chat with yourself. Saved Messages is that dialog. It is not in this fixture and not a fourth kind. Chat is the umbrella. The page is a chat list.
- A supergroup is a group. A broadcast channel is a channel. There is no fourth kind. See [ADR 0002](../adr/0002-supergroup-is-a-group.md).
- Each chat has an opaque chat id. The row does not show it. The id is not a Telegram peer id. Later tickets fill real ids.
- No page heading and no shell label. The document title stays empty. The list is the whole page.
- Rows are not buttons. There is no selection and no navigation. Opening a chat stays on KAM-44.
- Fixture, in order: Ada (dialog, id `ada`), Book club (group, id `book-club`), Announcements (channel, id `announcements`). Kind text is Dialog, Group, or Channel.
- Crate path `crates/core`, package `crm-chat-core`. `crates/wasm-check` is removed. The flake wasm32 check compiles this crate and does not need a browser `.wasm` artifact.
- Generated types are committed under `web/`, because the website package builds from `web/` only and has no Rust toolchain. The flake check fails if the committed file is stale. The generator must not instantiate WASM.
- A Telegram peer that is not a user, a basic group, a supergroup, or a broadcast channel is not classified here. A later ticket assigns it to one of the three kinds and does not add a fourth.

## Unresolved technical parameter

None. ts-rs 12.0.1 emits the committed types and `cargo check -p crm-chat-core --target wasm32-unknown-unknown` succeeded on the host. No generator swap.

## Inherited, not re-opened

From KAM-39 and KAM-40: one core, no sockets in it, Telegram only, the old messenger trait is not ported, Foldkit on Effect, no React, Linux and wasm32 are the release targets, both shells open one page. Login, real chat lists, and both adapters are later tickets.

## Not this ticket

Phone, QR, and 2FA. Several accounts. A live chat list. History, live updates, and opening a chat. Send, media, and search. WebSocket and TCP adapters. Sponsored messages. Forums. Unread, preview, time, avatar, pin, mute, and account on the chat type. A fallback title for a nameless chat. Which of the three kinds a peer outside the four named types gets.

## Existing behaviour, not ported

Verified in `crm-chat-legacy`: Convex `chatType` is Dialog or Group, with no Channel. `map_chat_type` sends `"user"` to Dialog and everything else, including a channel and a missing type, to Group. `MessengerClient` has a Telegram implementation and a mock. Neither is ported.

## Confirmation

Shared understanding accepted on 2026-10-28. Design approval is separate from verification.

## Verification

Local x86_64-linux, 2026-10-28:

- `cargo test -p crm-chat-core` passed. The committed types match the core. The manifest test finds no socket crates.
- `cargo build -p crm-chat-core --target wasm32-unknown-unknown` passed and produced `libcrm_chat_core.rlib`, not a browser `.wasm`. The flake wasm32 check runs that build.
- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run lint:eslint` passed in `web/`. The scene test shows Ada, Book club, and Announcements, with kinds, and no button or heading.
- `nix flake check --accept-flake-config --keep-going` passed the host checks: website, desktop, wasm32, coreTypes, clippy, typescript, nix-fmt, nix-lint.
- `nix flake check --accept-flake-config --all-systems --no-build` evaluated aarch64-linux. It was not built.
- `nix develop --accept-flake-config -c true` exited 0.
- GitHub CI has not been run.
