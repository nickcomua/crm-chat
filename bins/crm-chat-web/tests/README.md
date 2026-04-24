# Integration Tests

This directory contains Playwright integration tests for the CRM Chat web application.

## Prerequisites

1. **Install Playwright browsers:**
   ```bash
   cd bins/crm-chat-web
   bun x playwright install chromium
   ```

2. **Set environment variables** (or add them to the repo-root `.env` file):
   ```bash
   export TEST_CLERK_USERNAME=tester
   export TEST_CLERK_PASSWORD=<your-test-password>
   export VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
   export TG_ID=<telegram-api-id>
   export TG_HASH=<telegram-api-hash>
   ```

## How It Works

Tests assume `devenv up` is already running in the repo root (started before the test suite). They connect to the existing services and clean up test data via Convex mutations.

1. `auth.setup.ts` signs in via Clerk, caches the user's tokenIdentifier, and calls `cleanupUser` to wipe stale data.
2. Tests run against the pre-running backend.
3. `global-teardown.ts` reads the cached tokenIdentifier and calls `cleanupUser` again to ensure no test data is left behind.

## Running Tests

```bash
cd bins/crm-chat-web

# Standard run (testcontainers handles all infra)
bun run test

# Interactive UI mode
bun run test:ui

# Headed mode (see the browser)
bun run test:headed
```

### Run against an external server

If you already have backend services running, set `TEST_BASE_URL` in your `secretspec.toml` profile or environment to point at the existing Vite dev server.

## Directory Structure

```
tests/
├── e2e-telegram/          # Tests requiring a real Telegram session
│   ├── scan-chats.spec.ts
│   ├── qr-auth.spec.ts
│   ├── qr-auth-real.spec.ts
│   ├── media-rendering.spec.ts
│   └── media-visual.spec.ts
├── auth.setup.ts          # Clerk auth setup + pre-test cleanup
├── global-teardown.ts     # Post-test data cleanup
├── helpers.ts             # Shared utilities (Convex clients, seeding, cleanup)
├── env.ts                 # Typed environment variables
└── *.spec.ts              # Seeded-data tests (no real Telegram needed)
```

**`tests/`** — Seeded-data tests that run against a Convex backend with synthetic test data. These don't need a Telegram session and run in the `chromium` Playwright project.

**`tests/e2e-telegram/`** — Tests that require a real Telegram session (`TG_SESSION_FILE_1` + `TG_USER_ID_1`). They run sequentially via the `tg-*` Playwright projects. Shared helpers (`helpers.ts`, `env.ts`) are imported from the parent directory.

## Test Files

| File | Description |
|------|-------------|
| `global-teardown.ts` | Post-suite cleanup (delete test user data via Convex mutation) |
| `helpers.ts` | Shared utilities: Clerk login, robot JWT minting, Convex client, test data seeding |
| `e2e-telegram/scan-chats.spec.ts` | Client settings page: chat list, scan toggles, inline name editing |
| `e2e-telegram/qr-auth.spec.ts` | QR code authentication flow (generation, decode, cancel) |
| `e2e-telegram/qr-auth-real.spec.ts` | Real QR auth backend verification (task creation, token step) |
| `e2e-telegram/media-rendering.spec.ts` | Media rendering: photos, videos, audio, documents, stickers, animations |
| `e2e-telegram/media-visual.spec.ts` | Visual constraints: thumbnail sizes, circular VideoNote, duration overlays |

## Test Configuration

Tests are configured in `playwright.config.ts`:
- Uses Chromium browser
- 60s timeout per test
- `auth.setup.ts` runs before dependent projects for authentication + cleanup
- Assumes `devenv up` is already running; no auto-started infrastructure

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TEST_CLERK_USERNAME` | Yes | Clerk test user username |
| `TEST_CLERK_PASSWORD` | Yes | Clerk test user password |
| `VITE_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key for the frontend |
| `TG_ID` | Yes | Telegram API ID |
| `TG_HASH` | Yes | Telegram API hash |
| `TEST_BASE_URL` | No | Override base URL (skips auto-started dev server) |
| `E2E_CONVEX_URL` | No | Set by global-setup; override to skip container startup |
| `E2E_ROBOT_PRIVATE_KEY` | No | Set by global-setup; robot JWT private key for test helpers |
