import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// ── Load .env at config time ────────────────────────────────────────
// Ensure env vars from .env are available for globalSetup validation
// and for the workerBackend fixture (which loads them independently too).
const ROOT = path.resolve(import.meta.dirname, "../..");
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1).replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

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
    baseURL: process.env.TEST_BASE_URL,
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
});
