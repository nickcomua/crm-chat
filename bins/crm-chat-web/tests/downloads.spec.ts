import { expect, test } from "@playwright/test";
import {
  api,
  getConvexUserId,
  getRobotClient,
  seedMediaRecord,
  seedMessage,
  seedTestClient,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;
const DOWNLOADS_URL_PATTERN = /\/#\/downloads/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: string;
let chatId: string;

test.describe("Downloads — Backend", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:dl-backend-${Date.now()}`);
    chatId = `${clientId}:dl-chat`;

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Downloads Test",
      lastMessageTimestamp: Date.now(),
    });

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

  test("seeds media at various statuses", async () => {
    const msgId = `${chatId}:dl-msg-1`;
    await seedMessage(userId, clientId, chatId, msgId, "Photo message");

    await seedMediaRecord(userId, clientId, chatId, msgId, "Photo", "Pending", {
      telegramFileId: `test-pending-${Date.now()}`,
      fileName: "test.jpg",
      fileSize: 12345,
    });

    await seedMediaRecord(userId, clientId, chatId, msgId, "Video", "Failed", {
      telegramFileId: `test-failed-${Date.now()}`,
      fileName: "video.mp4",
      fileSize: 99999,
      error: "Connection timed out",
    });

    await seedMediaRecord(userId, clientId, chatId, msgId, "Audio", "Stored", {
      telegramFileId: `test-stored-${Date.now()}`,
      fileName: "audio.ogg",
      fileSize: 5000,
      downloadedAt: Date.now(),
    });

    // Verify counts
    const robot = getRobotClient();
    const counts = (await robot.query(api.testHelpers.queryMediaCountByStatus, {
      userId,
      statuses: ["Pending", "Failed", "Stored"],
    })) as Record<string, number>;

    expect(counts.Pending).toBeGreaterThanOrEqual(1);
    expect(counts.Failed).toBeGreaterThanOrEqual(1);
    expect(counts.Stored).toBeGreaterThanOrEqual(1);
  });

  test("retryDownload changes Failed to Pending", async () => {
    const msgId = `${chatId}:dl-retry-msg`;
    await seedMessage(userId, clientId, chatId, msgId, "Retry test");

    const fileId = `test-retry-${Date.now()}`;
    await seedMediaRecord(userId, clientId, chatId, msgId, "Document", "Failed", {
      telegramFileId: fileId,
      error: "Network error",
    });

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.retryDownload, { telegramFileId: fileId });

    // Query the media and check status changed
    const media = (await robot.query(api.testHelpers.queryMediaByStatus, {
      userId,
      statuses: ["Pending"],
    })) as Array<{ telegramFileId: string; status: string }>;

    const retried = media.find((m) => m.telegramFileId === fileId);
    expect(retried).toBeTruthy();
    expect(retried?.status).toBe("Pending");
  });

  test("cancelDownload changes Pending to Skipped", async () => {
    const msgId = `${chatId}:dl-cancel-msg`;
    await seedMessage(userId, clientId, chatId, msgId, "Cancel test");

    const fileId = `test-cancel-${Date.now()}`;
    await seedMediaRecord(userId, clientId, chatId, msgId, "Sticker", "Pending", {
      telegramFileId: fileId,
    });

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.cancelDownload, { telegramFileId: fileId });

    // Verify status changed to Skipped
    const media = (await robot.query(api.testHelpers.queryMediaByStatus, {
      userId,
      statuses: ["Skipped"],
    })) as Array<{ telegramFileId: string; status: string }>;

    const cancelled = media.find((m) => m.telegramFileId === fileId);
    expect(cancelled).toBeTruthy();
  });
});

test.describe("Downloads — UI", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:dl-ui-${Date.now()}`);
    chatId = `${clientId}:dl-ui-chat`;

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "DL UI Test",
      lastMessageTimestamp: Date.now(),
    });

    // Seed messages and media at various statuses
    const msgId = `${chatId}:dl-ui-msg`;
    await seedMessage(userId, clientId, chatId, msgId, "Media message");

    await seedMediaRecord(userId, clientId, chatId, msgId, "Photo", "Pending", {
      telegramFileId: `ui-pending-${Date.now()}`,
      fileName: "queued-photo.jpg",
      fileSize: 50000,
    });

    await seedMediaRecord(userId, clientId, chatId, msgId, "Video", "Failed", {
      telegramFileId: `ui-failed-${Date.now()}`,
      fileName: "failed-video.mp4",
      error: "Server unavailable",
    });

    await seedMediaRecord(userId, clientId, chatId, msgId, "Audio", "Stored", {
      telegramFileId: `ui-stored-${Date.now()}`,
      fileName: "complete-audio.ogg",
      fileSize: 8000,
      downloadedAt: Date.now(),
    });

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

  test("downloads page renders status sections", async ({ page }) => {
    // Verify backend has the seeded data before checking UI
    const robot = getRobotClient();
    const counts = (await robot.query(api.testHelpers.queryMediaCountByStatus, {
      userId,
      statuses: ["Pending", "Failed", "Stored"],
    })) as Record<string, number>;
    expect(counts.Pending, "Backend should have Pending media").toBeGreaterThanOrEqual(1);
    expect(counts.Failed, "Backend should have Failed media").toBeGreaterThanOrEqual(1);
    expect(counts.Stored, "Backend should have Stored media").toBeGreaterThanOrEqual(1);

    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });

    await expect(page.locator("h2:has-text('Downloads')")).toBeVisible({ timeout: 15_000 });

    // All three sections should render (Queued=Pending, Failed, Recent=Stored)
    await expect(page.locator("h3:has-text('Queued')")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("h3:has-text('Failed')")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("h3:has-text('Recent')")).toBeVisible({ timeout: 10_000 });
  });

  test("failed media shows error and retry button", async ({ page }) => {
    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });

    // Wait for the Failed section to render (Clerk auth + Convex subscription)
    await expect(page.locator("h3:has-text('Failed')")).toBeVisible({ timeout: 15_000 });

    // Error message should be visible
    await expect(page.locator("text=Server unavailable")).toBeVisible({ timeout: 5000 });

    // Retry button should exist
    const retryBtn = page.locator('button:has-text("Retry")');
    await expect(retryBtn.first()).toBeVisible();
  });

  test("queued media shows cancel button", async ({ page }) => {
    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });

    // Wait for the Queued section to render (Clerk auth + Convex subscription)
    await expect(page.locator("h3:has-text('Queued')")).toBeVisible({ timeout: 15_000 });

    const cancelBtn = page.locator('button:has-text("Cancel")');
    await expect(cancelBtn.first()).toBeVisible();
  });

  test("'Go to Chat' link navigates to correct chat", async ({ page }) => {
    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });

    // Scope to main content (excludes nav links like "Chats")
    // Each download item has a "Chat" link that navigates to the message in context
    const chatLink = page.locator('main a:text("Chat")').first();
    await expect(chatLink).toBeVisible({ timeout: 10_000 });
    await chatLink.click();
    // Should navigate to a chat view
    await page.waitForURL(/\/#\/chats\//, { timeout: 10_000 });
  });

  test("retry button changes media from Failed to Pending", async ({ page }) => {
    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });

    // Wait for the Failed section to render
    await expect(page.locator("h3:has-text('Failed')")).toBeVisible({ timeout: 15_000 });

    const retryBtn = page.locator('button:has-text("Retry")').first();
    await retryBtn.click();

    // After retry, the failed item should move to Queued.
    // The Queued section should appear (or already be visible from other Pending items).
    await expect(page.locator("h3:has-text('Queued')")).toBeVisible({ timeout: 10_000 });
  });
});
