# Rebuild context

Read this before changing shells, the Rust core, or Telegram behavior. The product being rebuilt is a local Telegram client. Two shells open one page. Vocabulary is in `GLOSSARY.md`.

## Do not revive the legacy stack

The old product lives at `~/Documents/crm-chat-legacy`. Use it as a reference. Do not import its history, copy its credentials, or port its architecture.

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
- No Convex, no Clerk, no worker, and no copied Telegram credentials. `secretspec.toml` declares only an optional `CACHIX_AUTH_TOKEN`.
- Foldkit skills are real files in `.agents/skills/`. `web/repos/foldkit` is an ignored local reference, not a submodule.

The browser adapter is `web/src/telegram.ts` (KAM-42): direct Telegram WSS with GramJS, separate clients per account, phone/QR/2FA, and real dialog loading. Credentials and sessions live in memory for the tab; reloading requires login again. The page collects a Telegram application API ID/hash from the person using it. No credentials are bundled. History, send, and media remain later tickets.
