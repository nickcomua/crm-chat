# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CRM Chat is an AI-powered application that aggregates conversations from Telegram (with potential future integrations to other messengers), stores them in a self-hosted Convex backend, and generates summaries for each contact. It highlights promises, plans, and recurring discussion topics, providing a personal CRM-like assistant.

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

This is a Rust/TypeScript monorepo with a self-hosted Convex backend and React frontend:

### Backend (Convex + Rust)
- **bins/convex-backend**: Self-hosted Convex project with schema, queries, and mutations
  - `convex/schema.ts` — all table definitions (humans, robots, clients, chats, messages, phoneAuths, qrAuths, notifications)
  - `convex/helpers/auth.ts` — shared auth helpers (requireHuman, requireRobot, requireOwner)
  - Auth is modeled as table-based state machines (`phoneAuth.ts`, `qrAuth.ts`)
  - Dual auth: Clerk JWTs for humans, self-signed RS256 JWTs for robot services
  - Run with `bunx convex dev` (reads `.env.local` for self-hosted URL and admin key)
- **bins/telegram-subscriber**: Rust service that connects to Convex via the Rust SDK, subscribes to auth queries, and spawns Telegram client connections
- **bins/es-proxy**: Elasticsearch proxy for semantic search / embeddings
- **bins/qr-login-test**: QR login testing utility
- **libs/convex-typegen**: Forked codegen tool that generates Rust types from `convex/schema.ts`
- **libs/messanger-interface**: Platform-agnostic traits for messenger clients (MessengerClient, ChatSummary, MessageSummary, etc.)
- **libs/messanger-telegram**: Telegram-specific implementation of the messenger interface using grammers
- **libs/hack**: Shared utilities

### Frontend (TypeScript/React)
- **bins/crm-chat-web**: React + Vite web application
  - Uses Convex React SDK (`useQuery`, `useMutation`) for real-time database subscriptions
  - Uses shadcn/ui components (Radix UI primitives)
  - Clerk for authentication, wrapped with `ConvexProviderWithClerk`
  - Follows Ultracite code standards (Biome-based linting/formatting)

### Infrastructure
- **docker-compose.yml**: Self-hosted Convex backend (port 3210) + dashboard (port 6791)
- Robot JWT auth: RS256 keypair — private key in `ROBOT_JWT_PRIVATE_KEY` env var for telegram-subscriber, public key configured as JWKS in Convex auth config

### Key Data Flow
1. Telegram clients connect through telegram-subscriber service
2. Messages/chats are synced to Convex via mutations
3. React frontend subscribes to Convex queries for real-time updates
4. Users can view aggregated conversations and AI-generated summaries

## Development Commands

### Nix Development Environment
This project uses Nix flakes for reproducible development environments:
```bash
# Enter dev shell
nix develop

# Build the entire project
nix build

# Run checks (clippy, formatting, tests, audit)
nix flake check
```

### Self-Hosted Convex Backend

Start the Convex backend (requires Docker):
```bash
docker compose up -d
```

Deploy/develop Convex functions (from `bins/convex-backend/`):
```bash
bunx convex dev          # dev mode with hot reload
bunx convex deploy       # deploy to self-hosted backend
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

### Frontend (crm-chat-web)

All commands run from `bins/crm-chat-web/`:

```bash
# Install dependencies
bun install

# Development server
bunx vite dev

# Build for production
bunx vite build

# Preview production build
bunx vite preview

# Lint/format with Ultracite (Biome)
bunx ultracite fix
bunx ultracite check
```

### Frontend Code Standards

The frontend follows Ultracite rules (see bins/crm-chat-web/.cursor/rules/ultracite.mdc):
- Use Biome for linting/formatting (`bunx ultracite fix`)
- Explicit types for function parameters and return values
- Arrow functions for callbacks
- `async/await` over promise chains
- Function components with proper hook usage
- Semantic HTML with accessibility attributes
- No `console.log`, `debugger`, or `alert` in production code
- **React Compiler is enabled**: Do NOT use `useMemo`, `useCallback`, or `memo()` - the compiler handles memoization automatically

## Important Implementation Details

### Convex Integration

The frontend uses the Convex React SDK:
- `ConvexProviderWithClerk` in `_auth.tsx` provides authenticated access
- `api` imported from `@/lib/convex` (uses `anyApi` until `bunx convex dev` generates typed bindings)
- Use `useQuery(api.module.function)` for reactive queries
- Use `useMutation(api.module.function)` for mutations

Example pattern:
```typescript
import { useMutation, useQuery } from "convex/react";
import { api } from "@/lib/convex";

function Component(): React.ReactNode {
  const clients = useQuery(api.clients.list);
  const deleteClient = useMutation(api.clients.deleteClient);

  if (clients === undefined) return <Spinner />;

  // Call a mutation
  deleteClient({ clientId: client._id });
}
```

Important Convex patterns:
- `useQuery` returns `undefined` while loading — components must handle loading state
- IDs are strings (`_id`)
- Enums are plain strings (e.g. `"Connected"`) or discriminated objects (`{ type: "Error", message: "..." }`)
- Timestamps are Unix milliseconds as `number`

### Authentication & Client Status

Client status is `{ type: "Authenticating" } | { type: "Connected" } | { type: "Error", message: string }`. Detailed auth state lives in separate tables:
- **PhoneAuth**: State machine with steps `SendingCode → WaitingCode → VerifyingCode → WaitingPassword → VerifyingPassword → Connected/Failed/Cancelled`
- **QrAuth**: QR-code-based login flow with its own step progression
- **Notification**: User-facing messages with severity (Info/Warning/Error)

telegram-subscriber subscribes to Convex queries for pending/assigned auth sessions and drives the authentication flow via `robot_*` mutations.

### Generated Code

- `bins/convex-backend/convex/_generated/` — auto-generated by `bunx convex dev`, do not edit manually
- `libs/convex-typegen` — generates Rust types from `convex/schema.ts` (used as build dependency)

### Environment Variables

Required environment variables:
- `VITE_CONVEX_URL`: Convex backend URL (e.g. `http://127.0.0.1:3210`)
- `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`: Clerk authentication
- `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`: Convex self-hosted admin (for `bins/convex-backend/`)
- `ROBOT_JWT_PRIVATE_KEY`: RS256 private key for robot JWT minting (telegram-subscriber)
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

Frontend tests use Playwright (from `bins/crm-chat-web/`):
```bash
bunx playwright test
```
