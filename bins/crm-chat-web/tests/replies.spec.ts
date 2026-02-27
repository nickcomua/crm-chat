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

test.describe("Replies — Backend", () => {
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
      `telegram:replies-test-${Date.now()}`
    );
    chatId = `${clientId}:replies-chat`;

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Replies Test",
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

  test("stores reply fields on a message", async () => {
    const originalMsgId = `${chatId}:msg-original`;
    await seedMessage(
      userId,
      clientId,
      chatId,
      originalMsgId,
      "Original message",
      {
        timestamp: Date.now() - 5000,
      }
    );

    const replyMsgId = `${chatId}:msg-reply`;
    await seedMessage(userId, clientId, chatId, replyMsgId, "This is a reply", {
      replyToMessageId: originalMsgId,
      replyToText: "Original message",
      timestamp: Date.now(),
    });

    const robot = getRobotClient();
    const msgs = (await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    })) as Array<{
      messageId: string;
      replyToMessageId?: string;
      replyToText?: string;
    }>;

    const reply = msgs.find((m) => m.messageId === replyMsgId);
    expect(reply).toBeTruthy();
    expect(reply?.replyToMessageId).toBe(originalMsgId);
    expect(reply?.replyToText).toBe("Original message");
  });

  test("message without reply has no reply fields", async () => {
    const msgId = `${chatId}:msg-no-reply`;
    await seedMessage(userId, clientId, chatId, msgId, "Not a reply");

    const robot = getRobotClient();
    const msgs = (await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    })) as Array<{ messageId: string; replyToMessageId?: string }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg).toBeTruthy();
    expect(msg?.replyToMessageId).toBeUndefined();
  });
});

test.describe("Replies — UI", () => {
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
      `telegram:replies-ui-${Date.now()}`
    );
    chatId = `${clientId}:replies-ui-chat`;

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Replies UI Test",
      lastMessageTimestamp: Date.now(),
    });

    const originalId = `${chatId}:ui-original`;
    await seedMessage(
      userId,
      clientId,
      chatId,
      originalId,
      "I said something important",
      {
        timestamp: Date.now() - 2000,
      }
    );

    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:ui-reply`,
      "Yes, I agree!",
      {
        replyToMessageId: originalId,
        replyToText: "I said something important",
        timestamp: Date.now(),
      }
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

  test("renders reply preview above message bubble", async ({ page }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    const replyMsg = page.locator(`[data-message-id="${chatId}:ui-reply"]`);
    await expect(replyMsg).toBeVisible({ timeout: 10_000 });

    // The reply preview should contain the original message text
    const replyPreview = replyMsg.locator('[data-testid="reply-preview"]');
    await expect(replyPreview).toBeVisible({ timeout: 5000 });
    await expect(replyPreview).toContainText("I said something important");
  });

  test("reply preview text is truncated for long messages", async ({
    page,
  }) => {
    // Seed a reply to a very long message
    const longText = "A".repeat(200);
    const longMsgId = `${chatId}:ui-long-original`;
    await seedMessage(userId, clientId, chatId, longMsgId, longText, {
      timestamp: Date.now() - 1000,
    });
    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:ui-long-reply`,
      "Reply to long",
      {
        replyToMessageId: longMsgId,
        replyToText: longText,
        timestamp: Date.now(),
      }
    );

    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    const replyMsg = page.locator(
      `[data-message-id="${chatId}:ui-long-reply"]`
    );
    await expect(replyMsg).toBeVisible({ timeout: 10_000 });

    const replyPreview = replyMsg.locator('[data-testid="reply-preview"]');
    await expect(replyPreview).toBeVisible({ timeout: 5000 });

    // Text should be truncated (not showing all 200 chars)
    const previewText = await replyPreview.textContent();
    expect(previewText).toBeTruthy();
    expect(previewText!.length).toBeLessThan(150);
  });
});
