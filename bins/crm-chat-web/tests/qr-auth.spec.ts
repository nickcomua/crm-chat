import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { api, getRobotClient } from "./helpers";

// URL patterns for navigation
const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/settings/;
const TG_LOGIN_URL_PATTERN = /^tg:\/\/login\?token=.+/;

// Telegram subscriber needs time to claim the auth and fetch the QR token
const QR_CODE_TIMEOUT = 30_000;

/**
 * Poll until no QrAuth worker tasks remain (Pending, Dispatched, or Running).
 * Uses the robot client to query the task list.
 */
async function expectNoQrAuthTasks(timeoutMs = 15_000): Promise<void> {
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

// Run tests sequentially — they share a single Clerk test account
test.describe.configure({ mode: "serial" });

test.describe("QR Code Authentication", () => {
  test.beforeEach(async ({ page }) => {
    // Auth is handled by storageState from auth.setup.ts
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    // Navigate to settings
    await page.locator('a[href="/#/settings"]').click({ timeout: 10_000 });
    await page.waitForURL(SETTINGS_URL_PATTERN);
    await page.waitForSelector("text=Telegram Clients", { timeout: 10_000 });
  });

  test("should display scannable QR code when clicking Add Client", async ({
    page,
  }) => {
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

  test("should cancel QR auth task when dialog is closed", async ({ page }) => {
    // Click Add Client button (already on settings page from beforeEach)
    await page.click('button:has-text("Add Client")');

    // Wait for dialog with QR auth content
    await page.waitForSelector('[role="dialog"]');

    // Wait briefly so the task is created and potentially dispatched
    await page.waitForTimeout(2000);

    // Close the dialog via the X close button or Cancel button
    // This triggers QrAuth unmount → auto-cancel via cancelQrAuth()
    const closeBtn = page.locator('[role="dialog"] [data-slot="dialog-close"]');
    const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel")');
    const target = await Promise.race([
      closeBtn.waitFor({ timeout: 5000 }).then(() => closeBtn),
      cancelBtn.waitFor({ timeout: 5000 }).then(() => cancelBtn),
    ]);
    await target.click();

    // Dialog should close
    await expect(page.locator('[role="dialog"]')).toBeHidden({
      timeout: 10_000,
    });

    // Verify backend cleanup: no QrAuth tasks should remain
    // The cancel mutation fires immediately on unmount, and the worker's
    // cancel_watcher detects it and completes the task within seconds
    await expectNoQrAuthTasks();
  });

  test("should cancel QR auth task on page navigation", async ({ page }) => {
    // Start QR auth
    await page.click('button:has-text("Add Client")');
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(2000);

    // Navigate away (simulates leaving the page)
    // The beforeunload handler fires sendBeacon to cancel the task
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Verify backend cleanup
    await expectNoQrAuthTasks();
  });
});
