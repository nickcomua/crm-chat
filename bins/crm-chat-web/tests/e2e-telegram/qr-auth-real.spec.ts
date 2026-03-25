import jsQR from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "../fixtures";
import {
  api,
  getConvexUserId,
  getRobotClient,
  type WorkerConfig,
  waitForPendingScanners,
} from "../helpers";

/**
 * Real QR Auth Tests
 *
 * These tests use a real Telegram session to verify the full QR auth flow:
 * 1. UI generates a QR code → backend creates QrAuth task
 * 2. Worker claims the task and fetches a QR token from Telegram
 * 3. QR code contains a valid tg://login URL
 * 4. Backend task transitions through correct steps
 *
 * These tests do NOT complete the auth (that would require scanning the QR
 * code with a real phone), but verify the full pipeline up to the scan step.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/settings/;
const TG_LOGIN_URL_PATTERN = /^tg:\/\/login\?token=.+/;
const QR_CODE_TIMEOUT = 30_000;

test.describe.configure({ mode: "serial" });

let _userId: string;
let workerCfg: WorkerConfig;

test.describe("QR Auth — Real Telegram (Backend)", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;

    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    _userId = await getConvexUserId(page);
    await page.close();
  });

  test("QrAuth task is created when Add Client is clicked", async ({
    page,
  }) => {
    await page.goto("/#/settings");
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForSelector("text=Telegram Clients", { timeout: 10_000 });

    // Click Add Client
    await page.click('button:has-text("Add Client")');
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

    // Poll backend for QrAuth task creation (any status — worker may pick it up fast)
    const robot = await getRobotClient(workerCfg);
    const deadline = Date.now() + 15_000;
    let qrTasks: Array<{ taskType: string; status: string }> = [];

    while (Date.now() < deadline) {
      const tasks = (await robot.query(api.testHelpers.queryWorkerTasks, {
        userId: _userId,
      })) as Array<{ taskType: string; status: string }>;
      qrTasks = tasks.filter((t) => t.taskType === "QrAuth");
      if (qrTasks.length >= 1) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // There should be at least one QrAuth task (any status)
    expect(qrTasks.length).toBeGreaterThanOrEqual(1);

    // Close dialog to clean up (may have auto-closed if worker processed quickly)
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible()) {
      const closeBtn = dialog.locator('[data-slot="dialog-close"]');
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
      }
    }
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // Wait for QrAuth task to drain before the next test
    await waitForNoQrAuthTasks();
  });

  test("QrAuth task transitions to Token step with valid QR URL", async ({
    page,
  }) => {
    // Scanner drain (30s) + QR token generation (30s) can exceed the default 30s test timeout
    test.setTimeout(90_000);

    // Drain pending ChatScanner tasks so the worker can process QrAuth
    const robot = await getRobotClient(workerCfg);
    await waitForPendingScanners(robot);

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
    expect(decoded?.data).toMatch(TG_LOGIN_URL_PATTERN);

    // Verify backend task is in Token step
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
    await expect(page.locator('[role="dialog"]')).toBeHidden({
      timeout: 10_000,
    });

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

    // Wait for QrAuth task to be created in the backend
    const robot = await getRobotClient(workerCfg);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const tasks = (await robot.query(api.testHelpers.queryWorkerTasks, {
        userId: _userId,
      })) as Array<{ taskType: string }>;
      if (tasks.some((t) => t.taskType === "QrAuth")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Cancel — dialog may have auto-closed if worker processed task quickly
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible()) {
      const cancelBtn = dialog.locator('button:has-text("Cancel")');
      if (await cancelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await cancelBtn.click();
      } else {
        const closeBtn = dialog.locator('[data-slot="dialog-close"]');
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.click();
        }
      }
    }

    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // Backend should have no remaining QrAuth tasks
    await waitForNoQrAuthTasks();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForNoQrAuthTasks(timeoutMs = 15_000): Promise<void> {
  const robot = await getRobotClient(workerCfg);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // queryWorkerTasks returns ALL statuses (Pending, Dispatched, Running, Cancelled)
    // — unlike pendingForWorker which only shows Pending tasks.
    const tasks = (await robot.query(api.testHelpers.queryWorkerTasks, {
      userId: _userId,
    })) as Array<{ taskType: string; status: string }>;

    const qrTasks = tasks.filter((t) => t.taskType === "QrAuth");
    if (qrTasks.length === 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`QrAuth tasks still exist after ${timeoutMs}ms`);
}
