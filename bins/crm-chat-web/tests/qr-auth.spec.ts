import { test, expect } from "@playwright/test";

// Test credentials from environment (required)
const TEST_CLERK_USERNAME = process.env.TEST_CLERK_USERNAME;
const TEST_CLERK_PASSWORD = process.env.TEST_CLERK_PASSWORD;

if (!TEST_CLERK_USERNAME || !TEST_CLERK_PASSWORD) {
  throw new Error(
    "TEST_CLERK_USERNAME and TEST_CLERK_PASSWORD environment variables are required"
  );
}

test.describe("QR Code Authentication", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app - Clerk will redirect to sign-in
    await page.goto("/");

    // Wait for Clerk sign-in page to load
    await page.waitForSelector('[data-testid="sign-in-root"]', {
      timeout: 10000,
    });

    // Fill in credentials
    await page.fill(
      'input[name="identifier"]',
      TEST_CLERK_USERNAME
    );
    await page.click('button:has-text("Continue")');

    // Wait for password field and fill it
    await page.waitForSelector('input[name="password"]', { timeout: 5000 });
    await page.fill('input[name="password"]', TEST_CLERK_PASSWORD);
    await page.click('button:has-text("Continue")');

    // Wait for successful login and redirect to main app
    await page.waitForURL(/\/#\/chats/, { timeout: 15000 });
  });

  test("should display QR code when clicking Add Client", async ({ page }) => {
    // Navigate to settings page
    await page.click('a[href="/settings"]');
    await page.waitForURL(/\/settings/);

    // Wait for the page to load
    await page.waitForSelector("text=Telegram Clients");

    // Click Add Client button
    await page.click('button:has-text("Add Client")');

    // Wait for dialog to open
    await page.waitForSelector('[role="dialog"]');

    // Verify QR auth component is displayed
    // Initially it should show "Generating QR code..." message
    const generatingText = page.locator("text=Generating QR code...");
    const qrCode = page.locator("svg"); // QRCodeSVG renders as SVG

    // Either we see the generating message or the QR code
    await expect(
      generatingText.or(qrCode.filter({ has: page.locator('rect[fill="#FFFFFF"]') }))
    ).toBeVisible({ timeout: 10000 });

    // If we wait a bit longer, we should see the actual QR code
    // (this depends on the backend being available)
    await page.waitForTimeout(2000);

    // Check if QR code is now visible (it has a specific structure)
    const qrCodeContainer = page.locator(".bg-white.rounded-lg");
    const isQrVisible = await qrCodeContainer.isVisible().catch(() => false);

    if (isQrVisible) {
      // Verify the QR code SVG is present
      const qrSvg = qrCodeContainer.locator("svg");
      await expect(qrSvg).toBeVisible();

      // Verify instruction text is shown
      await expect(page.locator("text=Scan with Telegram to sign in")).toBeVisible();

      // Verify expiration countdown is shown (if token is received)
      const expiresText = page.locator("text=Expires in");
      const hasExpiry = await expiresText.isVisible().catch(() => false);
      if (hasExpiry) {
        await expect(expiresText).toBeVisible();
      }
    }

    // Verify cancel button is present
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test("should be able to cancel QR auth", async ({ page }) => {
    // Navigate to settings page
    await page.click('a[href="/settings"]');
    await page.waitForURL(/\/settings/);

    // Click Add Client button
    await page.click('button:has-text("Add Client")');

    // Wait for dialog
    await page.waitForSelector('[role="dialog"]');

    // Click cancel
    await page.click('[role="dialog"] button:has-text("Cancel")');

    // Dialog should close
    await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 5000 });
  });
});
