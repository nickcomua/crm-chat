import { expect, test } from "./fixtures";
import {
  api,
  getConvexUserId,
  getRobotClient,
  type Id,
  seedMessage,
  seedTestClient,
  type WorkerConfig,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let chatId: string;
let workerCfg: WorkerConfig;

test.describe("Replies — Backend", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    userId = await getConvexUserId(page);
    const robot = await getRobotClient(workerCfg);
    clientId = await seedTestClient(
      userId,
      `telegram:replies-test-${Date.now()}`,
      robot
    );
    chatId = `${clientId}:replies-chat`;

    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Replies Test",
      lastMessageTimestamp: Date.now(),
    });

    await context.close();
  });

  test("stores reply fields on a message", async () => {
    const robot = await getRobotClient(workerCfg);
    const originalMsgId = `${chatId}:msg-original`;
    await seedMessage(
      userId,
      clientId,
      chatId,
      originalMsgId,
      "Original message",
      robot,
      {
        timestamp: Date.now() - 5000,
      }
    );

    const replyMsgId = `${chatId}:msg-reply`;
    await seedMessage(
      userId,
      clientId,
      chatId,
      replyMsgId,
      "This is a reply",
      robot,
      {
        replyToMessageId: originalMsgId,
        timestamp: Date.now(),
      }
    );

    const msgs = (await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    })) as Array<{
      messageId: string;
      replyToMessageId?: string;
    }>;

    const reply = msgs.find((m) => m.messageId === replyMsgId);
    expect(reply).toBeTruthy();
    expect(reply?.replyToMessageId).toBe(originalMsgId);
  });

  test("message without reply has no reply fields", async () => {
    const robot = await getRobotClient(workerCfg);
    const msgId = `${chatId}:msg-no-reply`;
    await seedMessage(userId, clientId, chatId, msgId, "Not a reply", robot);

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
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    userId = await getConvexUserId(page);
    const robot = await getRobotClient(workerCfg);
    clientId = await seedTestClient(
      userId,
      `telegram:replies-ui-${Date.now()}`,
      robot
    );
    chatId = `${clientId}:replies-ui-chat`;

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
      robot,
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
      robot,
      {
        replyToMessageId: originalId,
        timestamp: Date.now(),
      }
    );

    await context.close();
  });

  test("renders reply preview above message bubble", async ({ page }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    const replyMsg = page.locator(`[data-message-id="${chatId}:ui-reply"]`);
    await expect(replyMsg).toBeVisible({ timeout: 10_000 });

    // Verified: message-list.tsx:206 — data-testid="reply-preview"
    const replyPreview = replyMsg.locator('[data-testid="reply-preview"]');
    await expect(replyPreview).toBeVisible({ timeout: 5000 });
    await expect(replyPreview).toContainText("I said something important");
  });

  test("reply preview text is truncated for long messages", async ({
    page,
  }) => {
    const robot = await getRobotClient(workerCfg);
    // Seed a reply to a very long message
    const longText = "A".repeat(200);
    const longMsgId = `${chatId}:ui-long-original`;
    await seedMessage(userId, clientId, chatId, longMsgId, longText, robot, {
      timestamp: Date.now() - 1000,
    });
    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:ui-long-reply`,
      "Reply to long",
      robot,
      {
        replyToMessageId: longMsgId,
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
    expect(previewText?.length).toBeLessThan(150);
  });
});
