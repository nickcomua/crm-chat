# CRM Chat

An AI-powered application that aggregates conversations from Telegram (with potential future integrations to other messengers), stores them, and generates summaries for each contact. It highlights promises, plans, and recurring discussion topics, providing a personal CRM-like assistant.

## How It Works

1. Connect your Telegram account via phone number or QR code
2. CRM Chat syncs your conversations and media in real-time
3. Browse, search, and manage your contacts and chat history from the web interface

## Architecture

```
Browser (React) ◄──WebSocket──► Convex (Database) ◄──Rust SDK──► Worker ◄──► Telegram
```

- **Frontend**: React + Vite with real-time Convex subscriptions, Clerk auth, shadcn/ui
- **Backend**: Self-hosted Convex for database, functions, and file storage — also the job queue (each `pendingWork` query yields the entity set a worker job still needs to act on)
- **Worker**: Rust service using grammers for Telegram integration; subscribes to each `pendingWork` stream and spawns per-entity tokio tasks, aborting them when the entity leaves the set

See [Architecture](docs/ARCHITECTURE.md) for detailed diagrams and data flow.

## Quick Start

```bash
cp .env.example .env
# Fill in: TG_ID, TG_HASH, CLERK_M2M_SECRET_KEY, VITE_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY

docker compose up -d
docker compose exec backend ./generate_admin_key.sh
# Copy the key into .env as CONVEX_SELF_HOSTED_ADMIN_KEY

cd bins/convex-backend && bun install
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
CONVEX_SELF_HOSTED_ADMIN_KEY=<key-from-above> \
bun x convex deploy
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/GETTING_STARTED.md) | What CRM Chat does, prerequisites, and first-time setup |
| [Local Development Setup](docs/LOCAL_SETUP.md) | Full dev environment with Nix, step-by-step |
| [Deployment Guide](docs/DEPLOYMENT.md) | Docker production deployment, reverse proxy, monitoring |
| [Architecture](docs/ARCHITECTURE.md) | System design, data flow diagrams, database schema |
| [Environment Variables](docs/ENVIRONMENT.md) | Complete reference for all configuration |

## Project Structure

```
bins/
  convex-backend/    # Convex schema, queries, mutations
  crm-chat-web/      # React + Vite frontend
  crm-worker/        # Rust Telegram sync worker
libs/
  messanger-interface/  # Platform-agnostic messenger traits
  messanger-telegram/   # Telegram implementation (grammers)
  hack/                 # Shared utilities
  convex-typegen/       # Rust type generation from Convex schema
docs/                # Documentation
tests/
  e2e-telegram/      # End-to-end Telegram tests
```

## Development

This project uses [Nix](https://nixos.org/) for reproducible development environments and [Jujutsu (jj)](https://github.com/martinvonz/jj) for version control.

```bash
# Enter dev environment
direnv allow    # or: nix develop

# Run checks
nix flake check

# Build
cargo build                              # Rust workspace
cd bins/crm-chat-web && bun x vite build # Frontend
```
