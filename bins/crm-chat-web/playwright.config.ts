import { defineConfig, devices } from "@playwright/test";

// Fixed ports — must match global-setup.ts container config
const CONVEX_PORT = 13_210;
const TEST_PORT = 5174;

export default defineConfig({
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 60_000,
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
    },
  ],
  webServer: process.env.TEST_BASE_URL
    ? undefined
    : {
        command: `npx vite build && npx vite preview --port ${TEST_PORT}`,
        url: `http://localhost:${TEST_PORT}`,
        reuseExistingServer: false,
        env: {
          VITE_CONVEX_URL: `http://localhost:${CONVEX_PORT}`,
        },
      },
});
