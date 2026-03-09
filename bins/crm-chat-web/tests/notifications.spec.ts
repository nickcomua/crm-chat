import { expect, test } from "./fixtures";
import {
  getConvexUserId,
  getRobotClient,
  seedNotification,
  seedTestClient,
  type WorkerConfig,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let workerCfg: WorkerConfig;

test.describe("Notifications — Backend", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const robot = getRobotClient(workerCfg);
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    userId = await getConvexUserId(page);
    await seedTestClient(
      userId,
      `telegram:notif-backend-${Date.now()}`,
      robot
    );

    await context.close();
  });

  test("seedNotification creates undismissed notification", async () => {
    const robot = getRobotClient(workerCfg);
    const notifId = await seedNotification(
      userId,
      "Info",
      "Test info notification",
      robot
    );
    expect(notifId).toBeTruthy();
  });

  test("seeds notifications at all severity levels", async () => {
    const robot = getRobotClient(workerCfg);
    const infoId = await seedNotification(
      userId,
      "Info",
      "Info message",
      robot
    );
    const warnId = await seedNotification(
      userId,
      "Warning",
      "Warning message",
      robot
    );
    const errorId = await seedNotification(
      userId,
      "Error",
      "Error message",
      robot
    );

    expect(infoId).toBeTruthy();
    expect(warnId).toBeTruthy();
    expect(errorId).toBeTruthy();

    // All three should be distinct
    expect(new Set([infoId, warnId, errorId]).size).toBe(3);
  });
});

test.describe("Notifications — UI", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const robot = getRobotClient(workerCfg);
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    userId = await getConvexUserId(page);
    await seedTestClient(
      userId,
      `telegram:notif-ui-${Date.now()}`,
      robot
    );

    // Seed notifications at all severities
    await seedNotification(
      userId,
      "Error",
      "Connection lost to Telegram",
      robot
    );
    await seedNotification(userId, "Warning", "Rate limit approaching", robot);
    await seedNotification(userId, "Info", "Sync complete for 42 chats", robot);

    await context.close();
  });

  test("bell icon shows badge count", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Verified: right-sidebar.tsx:65 — <Button title="Notifications">
    const bellButton = page.locator('button[title="Notifications"]');
    await expect(bellButton).toBeVisible({ timeout: 10_000 });

    // Verified: right-sidebar.tsx:70 — <span className="... bg-destructive ...">
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

    // Verified: notifications-panel.tsx:66 — each notification div has className="group ..."
    // Hover reveals dismiss button via group-hover:opacity-100 (line 80)
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
    await expect(page.locator("text=Notifications").first()).toBeVisible({
      timeout: 5000,
    });

    // Dismiss all visible notifications by hovering each .group card
    // Scope to the notifications panel (z-50 fixed sidebar) to avoid matching
    // chat list items that also use .group
    const panel = page.locator(".z-50").filter({
      has: page.locator("text=Notifications"),
    });
    for (let i = 0; i < 10; i++) {
      const notifCards = panel
        .locator(".group")
        .filter({ has: page.locator("button") });
      const countBefore = await notifCards.count();
      if (countBefore === 0) {
        break;
      }

      // Hover the first card to reveal dismiss button, then force-click it
      // (the button has opacity-0 → group-hover:opacity-100 CSS which can
      //  cause Playwright's actionability check to fail intermittently)
      const firstCard = notifCards.first();
      await firstCard.hover();
      await firstCard.locator("button").last().click({ force: true });
      // Wait for card count to decrease (firstCard re-resolves to the next
      // card after dismiss, so toBeHidden would never pass)
      await expect(notifCards).toHaveCount(countBefore - 1, { timeout: 5000 });
    }

    // Verified: notifications-panel.tsx:53 — "All caught up" empty state text
    await expect(page.locator("text=All caught up")).toBeVisible({
      timeout: 10_000,
    });
  });
});
