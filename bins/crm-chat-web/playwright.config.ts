import { execSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

// ── Port allocation ─────────────────────────────────────────────────
// Playwright starts webServer BEFORE globalSetup, so ports must be
// allocated here (at config eval time) and passed via env vars.
// globalSetup reads them instead of allocating its own.
if (!process.env.E2E_CONVEX_PORT) {
  const ports: number[] = JSON.parse(
    execSync("node tests/find-ports.mjs 6", {
      encoding: "utf-8",
      cwd: import.meta.dirname,
    }).trim()
  );
  process.env.E2E_CONVEX_PORT = String(ports[0]);
  process.env.E2E_SITE_PORT = String(ports[1]);
  process.env.E2E_RESTATE_INGRESS_PORT = String(ports[2]);
  process.env.E2E_RESTATE_ADMIN_PORT = String(ports[3]);
  process.env.E2E_WORKER_PORT = String(ports[4]);
  process.env.E2E_VITE_PORT = String(ports[5]);
}

const CONVEX_PORT = Number(process.env.E2E_CONVEX_PORT);
const TEST_PORT = Number(process.env.E2E_VITE_PORT) || 5174;

export default defineConfig({
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 30_000,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? `http://localhost:${TEST_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/.auth/user.json",
      },
      dependencies: ["setup"],
      testIgnore: [
        /e2e-telegram\/scan-chats\.spec/,
        /e2e-telegram\/media-rendering\.spec/,
        /e2e-telegram\/media-visual\.spec/,
        /e2e-telegram\/qr-auth\.spec/,
        /e2e-telegram\/qr-auth-real\.spec/,
      ],
    },
    // Real-TG specs run sequentially via dependency chain.
    // The worker has limited task processing capacity — parallel specs
    // that create worker tasks (QR auth, ChatScanner) compete for resources,
    // causing ChatScanner to stall during message fetching.
    {
      name: "tg-scan",
      testMatch: /e2e-telegram\/scan-chats\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "tg-qr-auth",
      testMatch: /e2e-telegram\/qr-auth\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/.auth/user.json",
      },
      dependencies: ["tg-scan"],
    },
    {
      name: "tg-qr-auth-real",
      testMatch: /e2e-telegram\/qr-auth-real\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/.auth/user.json",
      },
      dependencies: ["tg-qr-auth"],
    },
    {
      name: "tg-media-render",
      testMatch: /e2e-telegram\/media-rendering\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/.auth/user.json",
      },
      dependencies: ["tg-qr-auth-real"],
    },
    {
      name: "tg-media-visual",
      testMatch: /e2e-telegram\/media-visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/.auth/user.json",
      },
      dependencies: ["tg-media-render"],
    },
  ],
  webServer: process.env.TEST_BASE_URL
    ? undefined
    : {
        command: `bunx vite build && bunx vite preview --port ${TEST_PORT}`,
        url: `http://localhost:${TEST_PORT}`,
        reuseExistingServer: !process.env.CI,
        env: {
          VITE_CONVEX_URL: `http://localhost:${CONVEX_PORT}`,
        },
      },
});
