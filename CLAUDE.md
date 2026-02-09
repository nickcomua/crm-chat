# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CRM Chat is an AI-powered application that aggregates conversations from Telegram (with potential future integrations to other messengers), stores them in SpacetimeDB, and generates summaries for each contact. It highlights promises, plans, and recurring discussion topics, providing a personal CRM-like assistant.

## Version Control

This repository uses **Jujutsu (jj)** instead of git. Jujutsu is a modern VCS that coexists with git but provides a more intuitive workflow.

### Common jj Commands

```bash
# View working copy status
jj status

# Create a new change (similar to git add + commit)
jj commit -m "message"

# Amend the current change
jj describe -m "new message"

# View change history
jj log

# Create a new change on top of current
jj new

# Move to a different change
jj edit <change-id>

# Rebase current change
jj rebase -d <destination>

# Push to git remote (coexists with git)
jj git push

# Pull from git remote
jj git fetch
```

### Configured Aliases

- `trunk()` - References `main@origin` (the main branch on the remote)

### Working with Git

Jujutsu maintains compatibility with git:
- The repository can be interacted with using both `jj` and `git` commands
- Changes made with `jj` are reflected in the underlying git repository
- Use `jj git push`/`jj git fetch` to sync with git remotes

## Architecture

This is a Rust/TypeScript monorepo with a SpacetimeDB backend and React frontend:

### Backend (Rust)
- **bins/sdb_server**: SpacetimeDB module defining the database schema, tables, and reducers
  - Contains the core data model (User, Client, Chat, Message, Media, Board, QA, Note, PhoneAuth, QrAuth, Notification tables)
  - Auth is modeled as table-based state machines (`phone_auth.rs`, `qr_auth.rs`) rather than a task queue
  - See bins/sdb_server/README.md for the ER diagram and RLS (Row Level Security) overview
- **bins/telegram-subscriber**: Service that subscribes to SpacetimeDB client events and spawns Telegram client connections
- **bins/es-proxy**: Elasticsearch proxy for semantic search / embeddings
- **bins/qr-login-test**: QR login testing utility
- **libs/sdb_api**: Generated Rust bindings for the SpacetimeDB module (auto-generated, do not edit manually)
- **libs/messanger-interface**: Platform-agnostic traits for messenger clients (MessengerClient, ChatSummary, MessageSummary, etc.)
- **libs/messanger-telegram**: Telegram-specific implementation of the messenger interface using grammers
- **libs/hack**: Shared utilities

### Frontend (TypeScript/React)
- **bins/crm-chat-web**: React + Vite web application
  - Uses SpacetimeDB React SDK for real-time database connection
  - TypeScript bindings in src/lib/spacetime/ are auto-generated from the SpacetimeDB module
  - Uses shadcn/ui components (Radix UI primitives)
  - Clerk for authentication
  - Follows Ultracite code standards (Biome-based linting/formatting)

### Key Data Flow
1. Telegram clients connect through telegram-subscriber service
2. Messages/chats are synced to SpacetimeDB via reducers
3. React frontend subscribes to SpacetimeDB tables for real-time updates
4. Users can view aggregated conversations and AI-generated summaries

## Development Commands

### Nix Development Environment
This project uses Nix flakes for reproducible development environments:
```bash
# Enter dev shell (provides all dependencies including SpacetimeDB CLI)
nix develop

# Build the entire project
nix build

# Run checks (clippy, formatting, tests, audit)
nix flake check
```

### Rust Backend

Build all workspace members:
```bash
cargo build
```

Run clippy:
```bash
cargo clippy --all-targets -- --deny warnings
```

Format code:
```bash
cargo fmt
```

Run tests:
```bash
cargo test
# Or with nextest:
cargo nextest run
```

Audit dependencies:
```bash
cargo audit
```

### SpacetimeDB Module

Publish the SpacetimeDB module (from bins/sdb_server):
```bash
cd bins/sdb_server
spacetime publish <module-name> --clear-database
```

Generate client bindings:
```bash
# Rust bindings (updates libs/sdb_api/src/module_bindings/)
cd bins/sdb_server
spacetime generate --lang rust --out-dir ../../libs/sdb_api/src/module_bindings

# TypeScript bindings for web frontend
cd bins/crm-chat-web
npm run gen
# or: spacetime generate --lang typescript --out-dir ./src/lib/spacetime --project-path ../sdb_server
```

### Frontend (crm-chat-web)

All commands run from `bins/crm-chat-web/`:

```bash
# Install dependencies
npm install

# Development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint/format with Ultracite (Biome)
npx ultracite fix
npx ultracite check

# Generate SpacetimeDB TypeScript bindings
npm run gen
```

### Frontend Code Standards

The frontend follows Ultracite rules (see bins/crm-chat-web/.cursor/rules/ultracite.mdc):
- Use Biome for linting/formatting (`npx ultracite fix`)
- Explicit types for function parameters and return values
- Arrow functions for callbacks
- `async/await` over promise chains
- Function components with proper hook usage
- Semantic HTML with accessibility attributes
- No `console.log`, `debugger`, or `alert` in production code
- **React Compiler is enabled**: Do NOT use `useMemo`, `useCallback`, or `memo()` - the compiler handles memoization automatically

## Important Implementation Details

### SpacetimeDB Integration

The frontend uses SpacetimeDB React SDK:
- Generated TypeScript bindings are in `bins/crm-chat-web/src/lib/spacetime/`
- Use `useTable()` from `spacetimedb/react` for reactive table subscriptions
- Use `useReducer()` from `spacetimedb/react` to call reducers
- Import `tables` and `reducers` from `@/lib/spacetime`

Example pattern:
```typescript
import { useReducer, useTable } from "spacetimedb/react";
import { tables, reducers } from "@/lib/spacetime";

function Component() {
  const [clients] = useTable(tables.client);
  const [chats] = useTable(tables.chat);
  const deleteClient = useReducer(reducers.deleteClient);

  // Call a reducer
  deleteClient(clientId);
}
```

### Authentication & Client Status

Client status is `Authenticating | Connected | Error(String)`. Detailed auth state lives in separate tables:
- **PhoneAuth**: State machine with steps `SendingCode → WaitingCode → VerifyingCode → WaitingPassword → VerifyingPassword → Connected/Failed/Cancelled`
- **QrAuth**: QR-code-based login flow with its own step progression
- **Notification**: Replaces the old DisplayMessage task; used for user-facing messages with severity (Info/Warning/Error)

telegram-subscriber watches for PhoneAuth/QrAuth inserts and drives the authentication flow via `robot_*` reducers.

### Generated Code

These files are auto-generated and should not be manually edited:
- `libs/sdb_api/src/module_bindings/` - Regenerate with `spacetime generate --lang rust`
- `bins/crm-chat-web/src/lib/spacetime/` - Regenerate with `npm run gen`

### Environment Variables

See `.env.example` for required environment variables:
- `VITE_SPACETIMEDB_MODULE`, `VITE_SPACETIMEDB_HOST`: SpacetimeDB connection
- `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`: Clerk authentication
- `TG_ID`, `TG_HASH`: Telegram API credentials
- `OPENROUTER_API_KEY`: OpenRouter for embeddings
- `ES_*`: Elasticsearch configuration (optional)
- `SENTRY_URL`: Sentry error tracking (optional)

Frontend env vars are validated with `@t3-oss/env-core` and Zod in `bins/crm-chat-web/src/env.ts`.

## Testing

Run Rust tests:
```bash
cargo test --workspace
```

Run specific test:
```bash
cargo test -p messanger-telegram test_name
```

Frontend tests are not yet implemented.
