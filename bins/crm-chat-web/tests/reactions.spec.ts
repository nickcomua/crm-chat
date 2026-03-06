import { expect, test } from "./fixtures";
import {
  api,
  getConvexUserId,
  getRobotClient,
  seedMessage,
  seedTestClient,
  type WorkerConfig,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: string;
let chatId: string;
let workerCfg: WorkerConfig;

test.describe("Reactions — Backend", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    userId = await getConvexUserId(page);
    const robot = getRobotClient(workerCfg);
    clientId = await seedTestClient(
      userId,
      `telegram:reactions-test-${Date.now()}`,
      robot
    );
    chatId = `${clientId}:reactions-chat`;

    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Reactions Test",
      lastMessageTimestamp: Date.now(),
    });

    await page.close();
  });

  test("stores reactions on a message", async () => {
    const robot = getRobotClient(workerCfg);
    const msgId = `${chatId}:msg-react-1`;
    await seedMessage(
      userId,
      clientId,
      chatId,
      msgId,
      "Hello!",
      {
        reactions: [
          {
            emoji: "❤️",
            count: 3,
            recent: [{ userId: "user-a" }, { userId: "user-b" }],
          },
          { emoji: "👍", count: 1, recent: [{ userId: "user-c" }] },
        ],
      },
      robot
    );

    // Query the message and verify reactions
    const msgs = (await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    })) as Array<{
      messageId: string;
      reactions?: Array<{ emoji: string; count: number }>;
    }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg).toBeTruthy();
    expect(msg?.reactions).toHaveLength(2);
    expect(msg?.reactions?.[0].emoji).toBe("❤️");
    expect(msg?.reactions?.[0].count).toBe(3);
    expect(msg?.reactions?.[1].emoji).toBe("👍");
  });

  test("updates reaction count on existing message", async () => {
    const robot = getRobotClient(workerCfg);
    const msgId = `${chatId}:msg-react-2`;
    await seedMessage(
      userId,
      clientId,
      chatId,
      msgId,
      "Update me",
      {
        reactions: [{ emoji: "😂", count: 1, recent: [{ userId: "user-a" }] }],
      },
      robot
    );

    // Update with new count
    await seedMessage(
      userId,
      clientId,
      chatId,
      msgId,
      "Update me",
      {
        reactions: [
          {
            emoji: "😂",
            count: 5,
            recent: [{ userId: "user-a" }, { userId: "user-b" }],
          },
        ],
      },
      robot
    );

    const msgs = (await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    })) as Array<{
      messageId: string;
      reactions?: Array<{ emoji: string; count: number }>;
    }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg?.reactions?.[0].count).toBe(5);
  });

  test("message without reactions has no reactions field", async () => {
    const robot = getRobotClient(workerCfg);
    const msgId = `${chatId}:msg-no-react`;
    await seedMessage(
      userId,
      clientId,
      chatId,
      msgId,
      "No reactions here",
      undefined,
      robot
    );

    const msgs = (await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    })) as Array<{ messageId: string; reactions?: unknown }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg).toBeTruthy();
    expect(msg?.reactions).toBeUndefined();
  });
});

test.describe("Reactions — UI", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    userId = await getConvexUserId(page);
    const robot = getRobotClient(workerCfg);
    clientId = await seedTestClient(
      userId,
      `telegram:reactions-ui-${Date.now()}`,
      robot
    );
    chatId = `${clientId}:reactions-ui-chat`;

    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Reactions UI Test",
      lastMessageTimestamp: Date.now(),
    });

    // Seed messages with reactions
    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:ui-msg-1`,
      "Message with reactions",
      {
        reactions: [
          { emoji: "❤️", count: 3, recent: [{ userId: "u1" }] },
          { emoji: "😂", count: 7, recent: [{ userId: "u2" }] },
        ],
        timestamp: Date.now(),
      },
      robot
    );

    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:ui-msg-2`,
      "No reactions",
      {
        timestamp: Date.now() - 1000,
      },
      robot
    );

    await page.close();
  });

  test("renders reaction badges on a message", async ({ page }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    // Wait for the message with reactions to appear
    const msgEl = page.locator(`[data-message-id="${chatId}:ui-msg-1"]`);
    await expect(msgEl).toBeVisible({ timeout: 10_000 });

    // Verified: message-list.tsx:124 — data-testid="reactions"
    // Scoped to reactions container to avoid matching timestamp digits
    const reactions = msgEl.locator('[data-testid="reactions"]');
    await expect(reactions).toBeVisible({ timeout: 5000 });

    await expect(reactions.locator('text="❤️"')).toBeVisible();
    await expect(reactions.locator('text="😂"')).toBeVisible();

    // Verify counts are displayed
    await expect(reactions.getByText("3", { exact: true })).toBeVisible();
    await expect(reactions.getByText("7", { exact: true })).toBeVisible();
  });

  test("message without reactions shows no reaction UI", async ({ page }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    const msgEl = page.locator(`[data-message-id="${chatId}:ui-msg-2"]`);
    await expect(msgEl).toBeVisible({ timeout: 10_000 });

    // No reaction badges should be present on this message
    const reactions = msgEl.locator('[data-testid="reactions"]');
    await expect(reactions).toHaveCount(0);
  });

  test("multiple reaction types render side by side", async ({ page }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    const msgEl = page.locator(`[data-message-id="${chatId}:ui-msg-1"]`);
    await expect(msgEl).toBeVisible({ timeout: 10_000 });

    // Both emoji badges should be children of the same reactions container
    const reactionContainer = msgEl.locator('[data-testid="reactions"]');
    await expect(reactionContainer).toBeVisible({ timeout: 5000 });

    // Verified: message-list.tsx:134 — data-testid="reaction-badge"
    const badges = reactionContainer.locator('[data-testid="reaction-badge"]');
    await expect(badges).toHaveCount(2);
  });
});
