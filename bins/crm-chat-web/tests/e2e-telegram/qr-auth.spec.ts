import jsQR from "jsqr";
import { PNG } from "pngjs";
import { expect, test } from "../fixtures";
import {
  api,
  getRobotClient,
  type WorkerConfig,
  waitForPendingScanners,
} from "../helpers";

// URL patterns for navigation
const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/settings/;
const TG_LOGIN_URL_PATTERN = /^tg:\/\/login\?token=.+/;

// Telegram subscriber needs time to claim the auth and fetch the QR token
const QR_CODE_TIMEOUT = 30_000;

let workerCfg: WorkerConfig;

/**
 * Poll until no QrAuth worker tasks remain (Pending, Dispatched, or Running).
 * Uses the robot client to query the task list.
 */
async function expectNoQrAuthTasks(timeoutMs = 15_000): Promise<void> {
  const robot = await getRobotClient(workerCfg);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const items = (await robot.query(
      api.model.qrAuth.pendingWork,
      {}
    )) as Array<{ service: string }>;

    if (items.length === 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`QrAuth work items still exist after ${timeoutMs}ms`);
}

// Run tests sequentially — they share a single Clerk test account
test.describe.configure({ mode: "serial" });

test.describe("QR Code Authentication", () => {
  test.beforeEach(async ({ page, workerBackend }) => {
    workerCfg = workerBackend;
    // Auth is handled by storageState from auth.setup.ts
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Navigate to settings
    await page.locator('a[href="/#/settings"]').click({ timeout: 10_000 });
    await page.waitForURL(SETTINGS_URL_PATTERN);
    await page.waitForSelector("text=Telegram Clients", { timeout: 10_000 });
  });

  // Cancel tests run first — they don't need the QR code to actually appear,
  // only that the task is created and then properly cancelled on unmount/navigation.

  test("should cancel QR auth task when dialog is closed", async ({ page }) => {
    // Click Add Client button (already on settings page from beforeEach)
    await page.click('button:has-text("Add Client")');

    // Wait for dialog with QR auth content
    await page.waitForSelector('[role="dialog"]');

    // Close immediately — if the worker processes the task quickly (isDone),
    // the dialog auto-closes. Either outcome (we close it, or it closes itself)
    // should result in cleanup via cancelQrAuth() on unmount.
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible()) {
      const closeBtn = dialog.locator('[data-slot="dialog-close"]');
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
      }
    }

    // Dialog should be hidden (either we closed it or it auto-closed)
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // Verify backend cleanup: no QrAuth tasks should remain
    // The cancel mutation fires immediately on unmount, and the worker's
    // domain watcher detects the terminal step and the workflow exits
    await expectNoQrAuthTasks();
  });

  test("should cancel QR auth task on page navigation", async ({ page }) => {
    // Start QR auth
    await page.click('button:has-text("Add Client")');
    await page.waitForSelector('[role="dialog"]');

    // Navigate away immediately — QrAuth unmount fires cancelQrAuth()
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Verify backend cleanup
    await expectNoQrAuthTasks();
  });

  // QR display test runs last — it requires the worker to connect to Telegram
  // and generate a real QR token, which takes up to 30s and depends on network.
  // If this test fails, the cancel tests above still run and pass independently.

  test("should display scannable QR code when clicking Add Client", async ({
    page,
  }) => {
    // Drain pending ChatScanner tasks from tg-scan so the worker can
    // pick up our QrAuth task without contention.
    const robot = await getRobotClient(workerCfg);
    await waitForPendingScanners(robot);

    // Click Add Client button
    await page.click('button:has-text("Add Client")');

    // Wait for dialog to open
    await page.waitForSelector('[role="dialog"]');

    // First we should see the loading state
    await expect(page.locator("text=Generating QR code...")).toBeVisible();

    // Wait for the actual QR code to appear (subscriber must generate the token)
    const qrCodeContainer = page.locator(
      '[role="dialog"] .rounded-lg.bg-white'
    );
    await expect(qrCodeContainer).toBeVisible({ timeout: QR_CODE_TIMEOUT });

    // Verify the QR code SVG is rendered inside the container
    const qrSvg = qrCodeContainer.locator("svg");
    await expect(qrSvg).toBeVisible();

    // Decode the QR code from a screenshot to verify it contains a valid Telegram login URL
    const screenshotBuffer = await qrCodeContainer.screenshot();
    const png = PNG.sync.read(screenshotBuffer);
    const decoded = jsQR(
      new Uint8ClampedArray(png.data),
      png.width,
      png.height
    );

    expect(decoded).not.toBeNull();
    if (decoded === null) {
      throw new Error("QR code could not be decoded");
    }
    expect(decoded.data).toMatch(TG_LOGIN_URL_PATTERN);

    // Verify instruction text
    await expect(
      page.locator("text=Scan with Telegram to sign in")
    ).toBeVisible();

    // Verify expiration countdown is shown
    await expect(page.locator("text=/Expires in \\d+s/")).toBeVisible();

    // Verify cancel button is present
    await expect(
      page.locator('[role="dialog"] button:has-text("Cancel")')
    ).toBeVisible();
  });
});
