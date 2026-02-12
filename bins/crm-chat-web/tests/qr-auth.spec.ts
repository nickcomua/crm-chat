import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";

// URL patterns for navigation
const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/settings/;
const TG_LOGIN_URL_PATTERN = /^tg:\/\/login\?token=.+/;

// Telegram subscriber needs time to claim the auth and fetch the QR token
const QR_CODE_TIMEOUT = 30_000;

// Run tests sequentially — they share a single Clerk test account
test.describe.configure({ mode: "serial" });

test.describe("QR Code Authentication", () => {
  test.beforeEach(async ({ page }) => {
    // Auth is handled by storageState from auth.setup.ts
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
    await page.waitForTimeout(2000);

    // Navigate to settings
    await page.locator('a[href="/#/settings"]').click({ timeout: 15_000 });
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

  test("should be able to cancel QR auth", async ({ page }) => {
    // Click Add Client button (already on settings page from beforeEach)
    await page.click('button:has-text("Add Client")');

    // Wait for dialog with QR auth content
    await page.waitForSelector('[role="dialog"]');

    // Close the dialog via the X close button
    // This triggers QrAuth unmount → auto-cancel cleanup
    await page.click('[role="dialog"] [data-slot="dialog-close"]');

    // Dialog should close
    await expect(page.locator('[role="dialog"]')).toBeHidden({
      timeout: 10_000,
    });
  });
});
