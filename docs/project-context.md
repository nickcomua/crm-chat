# Rebuild context

Read this before changing shells, the Rust core, or Telegram behavior. The product being rebuilt is a local Telegram client. Two shells open one page. Vocabulary is in `GLOSSARY.md`.

## Do not revive the legacy stack

The old product lives at `~/Documents/crm-chat-legacy`. Use it as a reference. Do not import its history or port its architecture. Do not copy Clerk, Convex, or other legacy credentials into this repo. Telegram application credentials are the exception in KAM-56: the same BWS-held values are declared for runtime injection, not committed. See `docs/secrets.md`.

Legacy shape: a React + Vite page talked to self-hosted Convex over WebSocket. A Rust worker talked to Telegram with grammers and to Convex with the Rust SDK. Clerk authenticated humans. The worker used Clerk machine-to-machine JWTs. Convex was the database, file store, and queue: worker jobs subscribed to `pendingWork` queries and spawned a tokio task per entity. There was no separate durable-workflow runtime and no worker HTTP API.

Legacy layout:

- `bins/crm-chat-web` — React, TanStack Router, shadcn/ui, Clerk, Convex React SDK
- `bins/convex-backend` — schema and functions. Tables included humans, robots, clients, chats, messages, phoneAuths, qrAuths, and notifications
- `bins/crm-worker` — DialogSync, ChatScanner, MediaDownloader, UpdateListener, ProfilePhotoSync, PhoneAuth, QrAuth
- `libs/messanger-interface` — messenger traits. Do not port this trait
- `libs/messanger-telegram` — grammers implementation
- `libs/convex-typegen` — Rust types generated from the Convex schema
- Optional Elasticsearch embeddings and Sentry

Login was phone-code or QR, then dialog sync, history scan, live updates, and media download. Summaries of promises, plans, and recurring topics were the product goal. Those behaviors are later tickets, not the current shells.

## This repo

Public `nickcomua/crm-chat`, empty history. `main` moves only by pull-request merge. A ruleset blocks direct pushes, including from admins, and requires the `check` workflow. Do not merge to `main` and do not push `main`. Do not open or update a pull request until the local CI job has passed: `nix flake check`, `nix build .#website .#desktop`, and `nix develop -c true`.

- `web/` is the web shell: a Foldkit page with browser Telegram login and real chat lists. Read `web/FOLDKIT.md` and `web/AGENTS.md` before changing it. No React. Effect code starts at `web/node_modules/effect/AGENTS.md`.
- `desktop/` is the desktop shell: Tauri 2, packaged with crane as `cargo tauri build --no-bundle`. The Nix package is the app. AppImage and deb are withdrawn. It opens the same page; native Telegram TCP is KAM-43.
- `crates/core` is the shared Rust core (`crm-chat-core`). It compiles for Linux and wasm32. TypeScript types are generated from it and committed at `web/src/generated/core.ts`. The core exports types only: no fixture function, no chat-list API, no sockets, no grammers. Design: `docs/plans/shared-core.md`.
- Rust checks use crane, fenix, and `cargo clippy --all-targets -- --deny warnings`.
- One dev shell: `nix develop`. Acceptance is `nix build` of the website and desktop package, plus `nix flake check`. A launched window is not the acceptance test.
- No Convex, no Clerk, and no worker. Telegram application credentials are declared in `secretspec.toml` and injected at runtime by `secretspec run --provider bws`. They are not copied into the repo, not bundled, and not Vite build variables. See `docs/secrets.md`.
- Foldkit skills are real files in `.agents/skills/`. `web/repos/foldkit` is an ignored local reference, not a submodule.

The page adapter is `web/src/telegram.ts`. In the desktop shell it calls Tauri commands backed by TDLib (`docs/plans/tdlib.md`), one database directory per account. In the browser it still uses GramJS until the emscripten TDLib package is cached. The core remains types only. Application API ID and hash come from SecretSpec at runtime. No credentials are bundled.
