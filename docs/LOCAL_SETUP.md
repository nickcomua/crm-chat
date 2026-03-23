# CRM Chat — Local Development Setup Guide

## Prerequisites

| Tool | Purpose |
|------|---------|
| **Nix** (recommended) | Reproducible dev environment with all tools |
| **Docker + Compose** | Self-hosted Convex backend, Restate, dashboard |
| **Clerk account** | User authentication (publishable key + secret) |
| **Telegram API credentials** | `TG_ID` + `TG_HASH` from [my.telegram.org](https://my.telegram.org) |

If you don't use Nix, you'll need: Rust (via rustup), bun, openssl-dev, sqlite-dev, pkg-config.

---

## Step 1: Enter the dev environment

setup direnv
https://direnv.net/docs/installation.html
```bash
direnv allow
```

This gives you Rust toolchain, bun, biome, cargo-nextest, and everything else.

---

## Step 2: Create your `.env` file

```bash
cp .env.example .env
```

Fill in the **required** values:

```bash
# Clerk (from Clerk dashboard)
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Telegram (from my.telegram.org)
TG_ID=12345678
TG_HASH=abcdef1234567890

# These get filled in by later steps:
# CONVEX_SELF_HOSTED_ADMIN_KEY=  (step 3)
# CLERK_M2M_SECRET_KEY=          (step 4)
```

Also create the Convex backend env:

```bash
# bins/convex-backend/.env.local
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
CONVEX_SELF_HOSTED_ADMIN_KEY=<from step 3>
```

---

## Step 3: Start Docker services

```bash
docker compose up -d
```

This starts three containers:

| Service | Port | Health check |
|---------|------|-------------|
| **Convex backend** | 3210 (API), 3211 (site proxy) | `curl http://localhost:3210/version` |
| **Convex dashboard** | 6791 | Depends on backend |
| **Restate** (workflow engine) | 8080 (ingress), 9070 (admin) | — |

Wait ~30s, then get the admin key:

```bash
# Generate admin key inside the container
docker compose exec backend ./generate_admin_key.sh
```

Copy that key into both `.env` and `bins/convex-backend/.env.local` as `CONVEX_SELF_HOSTED_ADMIN_KEY`.

> **Note:** The `docker-compose.yml` uses OrbStack DNS (`backend.crm-chat.orb.local`) for container-to-container communication. If you're on regular Docker Desktop, you may need to add `127.0.0.1 backend.crm-chat.orb.local` to `/etc/hosts`, or switch the `CONVEX_CLOUD_ORIGIN` back to `http://127.0.0.1:3210`.

---

## Step 4: Set Clerk M2M key

Add your Clerk machine-to-machine secret key to `.env`:

```bash
CLERK_M2M_SECRET_KEY=ak_...
```

Get this from the Clerk Dashboard under **Machines**. The worker uses this key to fetch JWTs from Clerk's M2M API at runtime.

---

## Step 5: Deploy Convex functions

```bash
cd bins/convex-backend
bun install
bunx convex dev    # dev mode with hot-reload
```

This deploys your schema + queries + mutations to the self-hosted backend and generates typed bindings in `convex/_generated/`.

Leave this running in a terminal — it watches for changes.

The project uses **dual auth**: Clerk JWTs for human users in the browser, and Clerk M2M JWTs for the worker service. Both are validated by the same Clerk provider in Convex auth config. Workers are identified by the `mch_` subject prefix. The `convex/helpers/auth.ts` file provides `requireHuman()` and `requireWorker()` helpers that mutations use to enforce access.

---

## Step 6: Build Rust workspace

In a separate terminal:

```bash
cargo build
```

This builds all workspace members: `crm-worker`, `es-proxy`, and the messenger libraries.

---

## Step 7: Start the frontend

```bash
cd bins/crm-chat-web
bun install
bunx vite dev
```

The dev server starts at **http://localhost:5173**. It connects to Convex at the URL from `VITE_CONVEX_URL` (defaults to `http://127.0.0.1:3210`).

---

## Step 8: Start the Rust worker

```bash
cargo run -p crm-worker
```

The worker:
1. Registers itself with Restate (workflow orchestration)
2. Connects to Convex and subscribes to auth queries
3. Spawns Telegram client connections when users authenticate
4. Runs chat sync, media download, profile photo sync services

---

## Ports at a glance

| Service | Port | URL |
|---------|------|-----|
| Convex API | 3210 | http://localhost:3210 |
| Convex Dashboard | 6791 | http://localhost:6791 |
| Restate Ingress | 8080 | http://localhost:8080 |
| Restate Admin | 9070 | http://localhost:9070 |
| Frontend (Vite) | 5173 | http://localhost:5173 |

---

## Verification checklist

```bash
# Convex is up?
curl -s http://localhost:3210/version

# Restate is up?
curl -s http://localhost:8080/

# Frontend loads?
open http://localhost:5173

# Run tests
cargo test --workspace
cd bins/crm-chat-web && bunx ultracite check
```

---

## Common issues

| Problem | Fix |
|---------|-----|
| `convex dev` fails — unknown admin key | Re-run `docker compose exec backend ./generate_admin_key.sh` and update `.env.local` |
| OrbStack DNS not resolving | Add `127.0.0.1 backend.crm-chat.orb.local` to `/etc/hosts` |
| serde build error (`__private` missing) | Already pinned: `serde = ">=1, <1.0.224"` in convex-backend/Cargo.toml |
| `cd` breaks in subshells | zoxide alias conflict — use absolute paths or `SHELL=/bin/bash bash -c '...'` |
| React perf warnings about memo | React Compiler is enabled — do NOT use `useMemo`/`useCallback`/`memo()` |

---

## Development commands cheat sheet

```bash
# Rust
cargo build                              # build all
cargo clippy --all-targets -- -D warnings # lint
cargo fmt                                # format
cargo nextest run                        # fast test runner

# Frontend (from bins/crm-chat-web/)
bunx vite dev                             # dev server
bunx vite build                           # production build
bunx ultracite fix                        # auto-fix lint/format
bunx ultracite check                      # verify compliance

# Convex (from bins/convex-backend/)
bunx convex dev                           # dev with hot-reload
bunx convex deploy                        # deploy to self-hosted

# Docker
docker compose up -d                     # start all services
docker compose down                      # stop all services
docker compose logs -f backend           # tail backend logs
```
