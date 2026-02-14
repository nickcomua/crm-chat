# Integration Tests

This directory contains Playwright integration tests for the CRM Chat web application.

## Prerequisites

1. **Install Playwright browsers:**
   ```bash
   cd bins/crm-chat-web
   bunx playwright install chromium
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

Tests use **testcontainers** to automatically spin up infrastructure:

1. `global-setup.ts` starts a Convex Docker container, generates robot RSA keys, deploys Convex functions, and launches `telegram-subscriber` as a child process.
2. Tests run against the ephemeral backend (no manual Docker/deploy needed).
3. `global-teardown.ts` kills the subscriber and stops the container.

The setup mirrors what `scripts/run-e2e-tests.sh` used to do, but programmatically via Bun.

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

### Run against an external server (skip testcontainers)

If you already have backend services running, set `TEST_BASE_URL` to skip the auto-started Vite dev server:

```bash
TEST_BASE_URL=https://crm-chat.kaminazuma.com bun test
```

Note: `global-setup.ts` still starts a Convex container unless you also set `E2E_CONVEX_URL` to point at your existing backend.

## Test Files

| File | Description |
|------|-------------|
| `global-setup.ts` | Testcontainers global setup (Convex container, robot keys, deploy, subscriber) |
| `global-teardown.ts` | Cleanup (kill subscriber, stop container) |
| `helpers.ts` | Shared utilities: Clerk login, robot JWT minting, Convex client, test data seeding |
| `qr-auth.spec.ts` | QR code authentication flow (generation, decode, cancel) |
| `scan-chats.spec.ts` | Client settings page: chat list, scan toggles, inline name editing |

## Test Configuration

Tests are configured in `playwright.config.ts`:
- Uses Chromium browser
- 60s timeout per test
- `globalSetup` / `globalTeardown` for infrastructure lifecycle
- Auto-starts Vite dev server unless `TEST_BASE_URL` is set

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
