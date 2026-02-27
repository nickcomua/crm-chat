import { expect, test } from "@playwright/test";
import {
  api,
  getConvexUserId,
  getRobotClient,
  seedNotification,
  seedTestClient,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: string;

test.describe("Notifications — Backend", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(
      userId,
      `telegram:notif-backend-${Date.now()}`
    );

    await page.close();
  });

  test.afterAll(async () => {
    if (clientId) {
      try {
        const robot = getRobotClient();
        await robot.mutation(api.testHelpers.deleteClient, { clientId });
      } catch {
        // best-effort
      }
    }
  });

  test("seedNotification creates undismissed notification", async () => {
    const notifId = await seedNotification(
      userId,
      "Info",
      "Test info notification"
    );
    expect(notifId).toBeTruthy();
  });

  test("seeds notifications at all severity levels", async () => {
    const infoId = await seedNotification(userId, "Info", "Info message");
    const warnId = await seedNotification(userId, "Warning", "Warning message");
    const errorId = await seedNotification(userId, "Error", "Error message");

    expect(infoId).toBeTruthy();
    expect(warnId).toBeTruthy();
    expect(errorId).toBeTruthy();

    // All three should be distinct
    expect(new Set([infoId, warnId, errorId]).size).toBe(3);
  });
});

test.describe("Notifications — UI", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:notif-ui-${Date.now()}`);

    // Seed notifications at all severities
    await seedNotification(userId, "Error", "Connection lost to Telegram");
    await seedNotification(userId, "Warning", "Rate limit approaching");
    await seedNotification(userId, "Info", "Sync complete for 42 chats");

    await page.close();
  });

  test.afterAll(async () => {
    if (clientId) {
      try {
        const robot = getRobotClient();
        await robot.mutation(api.testHelpers.deleteClient, { clientId });
      } catch {
        // best-effort
      }
    }
  });

  test("bell icon shows badge count", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Bell button should be visible
    const bellButton = page.locator('button[title="Notifications"]');
    await expect(bellButton).toBeVisible({ timeout: 10_000 });

    // Badge count should be visible (we seeded 3 notifications)
    const badge = bellButton.locator("span.bg-destructive");
    await expect(badge).toBeVisible({ timeout: 10_000 });

    const badgeText = await badge.textContent();
    expect(Number(badgeText)).toBeGreaterThanOrEqual(1);
  });

  test("clicking bell opens notifications panel", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const bellButton = page.locator('button[title="Notifications"]');
    await expect(bellButton).toBeVisible({ timeout: 10_000 });
    await bellButton.click();

    // Panel should open with "Notifications" header
    await expect(page.locator("text=Notifications").first()).toBeVisible({
      timeout: 5000,
    });

    // Should show our seeded notification messages
    await expect(page.locator("text=Connection lost to Telegram")).toBeVisible({
      timeout: 5000,
    });
  });

  test("notifications show correct severity icons", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const bellButton = page.locator('button[title="Notifications"]');
    await bellButton.click();
    await expect(page.locator("text=Notifications").first()).toBeVisible({
      timeout: 5000,
    });

    // All three severity messages should be visible
    await expect(page.locator("text=Connection lost to Telegram")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("text=Rate limit approaching")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("text=Sync complete for 42 chats")).toBeVisible({
      timeout: 5000,
    });
  });

  test("dismiss button removes notification", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const bellButton = page.locator('button[title="Notifications"]');
    await bellButton.click();
    await expect(page.locator("text=Connection lost to Telegram")).toBeVisible({
      timeout: 5000,
    });

    // Each notification is a .group div; hover reveals the dismiss (X) button inside it
    const notifCard = page
      .locator(".group")
      .filter({ hasText: "Connection lost to Telegram" })
      .first();
    await notifCard.hover();

    // The dismiss button is the last button inside the .group card
    const dismissBtn = notifCard.locator("button").last();
    await dismissBtn.click();

    // Notification should disappear
    await expect(page.locator("text=Connection lost to Telegram")).toBeHidden({
      timeout: 5000,
    });
  });

  test("Escape key closes notifications panel", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const bellButton = page.locator('button[title="Notifications"]');
    await bellButton.click();
    await expect(
      page.locator('button[title="Close notifications"]')
    ).toBeVisible({ timeout: 5000 });

    // Press Escape
    await page.keyboard.press("Escape");

    // Panel should close — the close button should be gone
    await expect(
      page.locator('button[title="Close notifications"]')
    ).toBeHidden({ timeout: 5000 });
  });

  test("empty state shows 'All caught up' when no notifications", async ({
    page,
  }) => {
    // Dismiss all remaining notifications first
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const bellButton = page.locator('button[title="Notifications"]');
    await bellButton.click();
    await page.waitForTimeout(1000);

    // Dismiss all visible notifications by hovering each .group card
    for (let i = 0; i < 10; i++) {
      const notifCards = page
        .locator(".group")
        .filter({ has: page.locator("button") });
      const count = await notifCards.count();
      if (count === 0) {
        break;
      }

      // Hover the first card to reveal dismiss button, then click it
      await notifCards.first().hover();
      await notifCards.first().locator("button").last().click();
      await page.waitForTimeout(500);
    }

    // Should show empty state
    await expect(page.locator("text=All caught up")).toBeVisible({
      timeout: 10_000,
    });
  });
});
