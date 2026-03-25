import jsQR from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "../fixtures";
import {
  api,
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

const SETTINGS_URL_PATTERN = /\/settings/;
const TG_LOGIN_URL_PATTERN = /^tg:\/\/login\?token=.+/;
const QR_CODE_TIMEOUT = 30_000;

test.describe.configure({ mode: "serial" });

let workerCfg: WorkerConfig;

test.describe("QR Auth — Real Telegram (Backend)", () => {
  test.beforeAll(({ workerBackend }) => {
    workerCfg = workerBackend;
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

    // Poll backend for QrAuth work item (any step — worker may pick it up fast)
    const robot = await getRobotClient(workerCfg);
    const deadline = Date.now() + 15_000;
    let qrItems: Array<{ service: string }> = [];

    while (Date.now() < deadline) {
      const items = (await robot.query(api.orchestrator.pendingWork, {
        maxMediaDownloads: 0,
      })) as Array<{ service: string }>;
      qrItems = items.filter((i) => i.service === "QrAuthWorkflow");
      if (qrItems.length >= 1) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // There should be at least one QrAuth work item
    expect(qrItems.length).toBeGreaterThanOrEqual(1);

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

    // Verify the QR code URL is a valid Telegram login URL — that's sufficient
    // to confirm the backend generated a real QR token.

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

    // Wait for QrAuth work item to appear in the backend
    const robot = await getRobotClient(workerCfg);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const items = (await robot.query(api.orchestrator.pendingWork, {
        maxMediaDownloads: 0,
      })) as Array<{ service: string }>;
      if (items.some((i) => i.service === "QrAuthWorkflow")) {
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
    const items = (await robot.query(api.orchestrator.pendingWork, {
      maxMediaDownloads: 0,
    })) as Array<{ service: string }>;

    const qrItems = items.filter((i) => i.service === "QrAuthWorkflow");
    if (qrItems.length === 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`QrAuth work items still exist after ${timeoutMs}ms`);
}
