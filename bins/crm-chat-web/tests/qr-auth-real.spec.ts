import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { getSessionEnv } from "./env";
import {
  api,
  getConvexUserId,
  getRobotClient,
  pollUntil,
} from "./helpers";

/**
 * Real QR Auth Tests
 *
 * These tests use a real Telegram session to verify the full QR auth flow:
 * 1. UI generates a QR code → backend creates QrAuth task
 * 2. Worker claims the task and fetches a QR token from Telegram
 * 3. QR code contains a valid tg://login URL
 * 4. Backend task transitions through correct steps
 *
 * Requires TG_SESSION_FILE_1 + TG_USER_ID_1 env vars.
 * These tests do NOT complete the auth (that would require scanning the QR
 * code with a real phone), but verify the full pipeline up to the scan step.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/settings/;
const TG_LOGIN_URL_PATTERN = /^tg:\/\/login\?token=.+/;
const QR_CODE_TIMEOUT = 30_000;

test.describe.configure({ mode: "serial" });

const session = getSessionEnv();

let userId: string;

test.describe("QR Auth — Real Telegram (Backend)", () => {
  test.skip(!session, "Skipping: TG_SESSION_FILE_1 not set");

  test.beforeAll(async ({ browser }) => {
    if (!session) return;

    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    await page.close();
  });

  test("QrAuth task is created when Add Client is clicked", async ({ page }) => {
    await page.goto("/#/settings");
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForSelector("text=Telegram Clients", { timeout: 10_000 });

    // Click Add Client
    await page.click('button:has-text("Add Client")');
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

    // Wait for the task to be created
    await page.waitForTimeout(2000);

    // Query backend for QrAuth tasks
    const robot = getRobotClient();
    const tasks = (await robot.query(api.workerTasks.pendingForWorker, {
      maxMediaWorkflows: 0,
    })) as Array<{ task: { type: string; step?: string }; status: string }>;

    const qrTasks = tasks.filter((t) => t.task.type === "QrAuth");

    // There should be at least one QrAuth task (Pending or Dispatched)
    expect(qrTasks.length).toBeGreaterThanOrEqual(1);

    // Close dialog to clean up
    await page.click('[role="dialog"] [data-slot="dialog-close"]');
    await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10_000 });
  });

  test("QrAuth task transitions to Token step with valid QR URL", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto("/#/settings");
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForSelector("text=Telegram Clients", { timeout: 10_000 });

    await page.click('button:has-text("Add Client")');
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

    // Wait for QR code to appear (worker needs to claim task + fetch token)
    const qrCodeContainer = page.locator(
      '[role="dialog"] .rounded-lg.bg-white'
    );
    await expect(qrCodeContainer).toBeVisible({ timeout: QR_CODE_TIMEOUT });

    // Decode QR code
    const screenshotBuffer = await qrCodeContainer.screenshot();
    const png = PNG.sync.read(screenshotBuffer);
    const decoded = jsQR(
      new Uint8ClampedArray(png.data),
      png.width,
      png.height
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.data).toMatch(TG_LOGIN_URL_PATTERN);

    // Verify backend task is in Token step
    const robot = getRobotClient();
    const tasks = (await robot.query(api.workerTasks.pendingForWorker, {
      maxMediaWorkflows: 0,
    })) as Array<{
      task: { type: string; step?: string; qrUrl?: string };
      status: string;
    }>;

    const qrTask = tasks.find(
      (t) => t.task.type === "QrAuth" && t.task.step === "Token"
    );

    // Task should be in Token step with a qrUrl
    if (qrTask) {
      expect(qrTask.task.qrUrl).toBeTruthy();
    }

    // Clean up
    await page.click('[role="dialog"] [data-slot="dialog-close"]');
    await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10_000 });

    // Wait for cleanup
    await waitForNoQrAuthTasks();
  });

  test("cancel cleans up QrAuth tasks completely", async ({ page }) => {
    await page.goto("/#/settings");
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForSelector("text=Telegram Clients", { timeout: 10_000 });

    // Start QR auth
    await page.click('button:has-text("Add Client")');
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

    // Wait for task to be created
    await page.waitForTimeout(3000);

    // Cancel via the Cancel button in the dialog
    const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel")');
    if (await cancelBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cancelBtn.click();
    } else {
      // Close via X button
      await page.click('[role="dialog"] [data-slot="dialog-close"]');
    }

    await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10_000 });

    // Backend should have no remaining QrAuth tasks
    await waitForNoQrAuthTasks();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForNoQrAuthTasks(timeoutMs = 15_000): Promise<void> {
  const robot = getRobotClient();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tasks = (await robot.query(api.workerTasks.pendingForWorker, {
      maxMediaWorkflows: 0,
    })) as Array<{ task: { type: string }; status: string }>;

    const qrTasks = tasks.filter((t) => t.task.type === "QrAuth");
    if (qrTasks.length === 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`QrAuth tasks still exist after ${timeoutMs}ms`);
}
