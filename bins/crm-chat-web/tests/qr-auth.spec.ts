import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";

// Test credentials from environment (required)
const TEST_CLERK_USERNAME = process.env.TEST_CLERK_USERNAME;
const TEST_CLERK_PASSWORD = process.env.TEST_CLERK_PASSWORD;

if (!(TEST_CLERK_USERNAME && TEST_CLERK_PASSWORD)) {
  throw new Error(
    "TEST_CLERK_USERNAME and TEST_CLERK_PASSWORD environment variables are required"
  );
}

// URL patterns for navigation
const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/settings/;

// Telegram subscriber needs time to claim the auth and fetch the QR token
const QR_CODE_TIMEOUT = 30_000;

// Run tests sequentially — they share a single Clerk test account
test.describe.configure({ mode: "serial" });

test.describe("QR Code Authentication", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app - Clerk will redirect to sign-in
    await page.goto("/");

    // Wait for Clerk sign-in page to load (identifier input)
    await page.waitForSelector('input[name="identifier"]', {
      timeout: 15_000,
    });

    // Fill in identifier and submit (Clerk multi-step flow)
    await page.fill('input[name="identifier"]', TEST_CLERK_USERNAME);
    await page.click("button.cl-formButtonPrimary");

    // Wait for password step and fill in
    await page.waitForSelector('input[name="password"]', { timeout: 10_000 });
    await page.fill('input[name="password"]', TEST_CLERK_PASSWORD);
    await page.click("button.cl-formButtonPrimary");

    // Wait for successful login and redirect to main app
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });

    // Give Convex subscriptions time to settle (queries cause re-renders after auth)
    await page.waitForTimeout(3000);

    // Navigate to settings and wait for it to be fully loaded
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
    if (decoded === null) throw new Error("QR code could not be decoded");
    expect(decoded.data).toMatch(/^tg:\/\/login\?token=.+/);

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
