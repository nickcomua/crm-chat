import { expect, test } from "@playwright/test";
import {
  api,
  getConvexUserId,
  getRobotClient,
  seedMessage,
  seedTestClient,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: string;
let chatId: string;

test.describe("Forwarded Messages — Backend", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:fwd-test-${Date.now()}`);
    chatId = `${clientId}:fwd-chat`;

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Forward Test",
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

  test("stores forwardedFrom on a message", async () => {
    const msgId = `${chatId}:msg-fwd-1`;
    await seedMessage(userId, clientId, chatId, msgId, "Forwarded content", {
      forwardedFrom: { senderName: "Alice Wonderland", date: 1700000000000 },
    });

    const robot = getRobotClient();
    const msgs = await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    }) as Array<{ messageId: string; forwardedFrom?: { senderName: string; date?: number } }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg).toBeTruthy();
    expect(msg?.forwardedFrom).toBeTruthy();
    expect(msg?.forwardedFrom?.senderName).toBe("Alice Wonderland");
    expect(msg?.forwardedFrom?.date).toBe(1700000000000);
  });

  test("forwardedFrom without date stores senderName only", async () => {
    const msgId = `${chatId}:msg-fwd-nodate`;
    await seedMessage(userId, clientId, chatId, msgId, "Forwarded, no date", {
      forwardedFrom: { senderName: "Bob" },
    });

    const robot = getRobotClient();
    const msgs = await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    }) as Array<{ messageId: string; forwardedFrom?: { senderName: string; date?: number } }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg?.forwardedFrom?.senderName).toBe("Bob");
    expect(msg?.forwardedFrom?.date).toBeUndefined();
  });

  test("normal message has no forwardedFrom", async () => {
    const msgId = `${chatId}:msg-normal`;
    await seedMessage(userId, clientId, chatId, msgId, "Not forwarded");

    const robot = getRobotClient();
    const msgs = await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    }) as Array<{ messageId: string; forwardedFrom?: unknown }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg).toBeTruthy();
    expect(msg?.forwardedFrom).toBeUndefined();
  });
});

test.describe("Forwarded Messages — UI", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:fwd-ui-${Date.now()}`);
    chatId = `${clientId}:fwd-ui-chat`;

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Forward UI Test",
      lastMessageTimestamp: Date.now(),
    });

    await seedMessage(userId, clientId, chatId, `${chatId}:ui-fwd`, "Check out this message!", {
      forwardedFrom: { senderName: "Alice Wonderland", date: 1700000000000 },
      timestamp: Date.now(),
    });

    await seedMessage(userId, clientId, chatId, `${chatId}:ui-normal`, "Just a normal message", {
      timestamp: Date.now() - 1000,
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

  test("renders 'Forwarded from' header on forwarded message", async ({ page }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    const fwdMsg = page.locator(`[data-message-id="${chatId}:ui-fwd"]`);
    await expect(fwdMsg).toBeVisible({ timeout: 10_000 });

    // Should show forwarded from header
    const fwdHeader = fwdMsg.locator('[data-testid="forwarded-from"]');
    await expect(fwdHeader).toBeVisible({ timeout: 5000 });
    await expect(fwdHeader).toContainText("Alice Wonderland");
  });

  test("normal message has no forwarded header", async ({ page }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    const normalMsg = page.locator(`[data-message-id="${chatId}:ui-normal"]`);
    await expect(normalMsg).toBeVisible({ timeout: 10_000 });

    const fwdHeader = normalMsg.locator('[data-testid="forwarded-from"]');
    await expect(fwdHeader).toHaveCount(0);
  });
});
