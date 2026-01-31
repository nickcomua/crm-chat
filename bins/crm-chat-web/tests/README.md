# Integration Tests

This directory contains Playwright integration tests for the CRM Chat web application.

## Prerequisites

1. **Install Playwright browsers:**
   ```bash
   cd bins/crm-chat-web
   npx playwright install chromium
   ```

2. **Start the telegram-subscriber service:**
   ```bash
   # From project root
   cd /home/user/crm-chat

   # Set environment variables
   export VITE_SPACETIMEDB_MODULE=<your-module-id>
   export VITE_SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
   export SPACETIMEDB_URI=https://maincloud.spacetimedb.com
   export DIRTY_IDENTITY=<your-robot-identity>
   export DIRTY_TOKEN=<your-robot-token>
   export TG_SUB_SECRET_TOKEN=<your-telegram-subscriber-secret>
   export TG_ID=<telegram-api-id>
   export TG_HASH=<telegram-api-hash>

   # Run the service
   ./target/release/telegram-subscriber
   ```

3. **Set test credentials:**
   ```bash
   export TEST_CLERK_USERNAME=tester
   export TEST_CLERK_PASSWORD=<your-test-password>
   ```

## Running Tests

### Run all tests
```bash
cd bins/crm-chat-web
npm test
```

### Run with UI (interactive mode)
```bash
npm run test:ui
```

### Run in headed mode (see browser)
```bash
npm run test:headed
```

## Test Files

- `qr-auth.spec.ts` - Tests for QR code authentication flow
  - Verifies QR code generation when clicking "Add Client"
  - Verifies cancel functionality

## Test Configuration

Tests are configured in `playwright.config.ts`:
- Uses Chromium browser
- Runs against `http://localhost:5173` (Vite dev server)
- Auto-starts dev server if not running
