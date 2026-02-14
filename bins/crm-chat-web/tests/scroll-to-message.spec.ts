import { expect, test } from "@playwright/test";
import { api, getConvexUserId, getRobotClient, unwrapResult } from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

// Run tests sequentially — they share seeded data.
test.describe.configure({ mode: "serial" });

test.describe("Scroll to Message", () => {
  let clientId: string;
  let chatId: string;
  let userId: string;
  // Target message in the first page (should scroll without loadMore).
  let firstPageTargetId: string;
  // Target message that requires loading a second page.
  let deepTargetId: string;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
    await page.waitForTimeout(3000);

    userId = await getConvexUserId(page);
    const robot = getRobotClient();

    // Create test client.
    clientId = unwrapResult<string>(
      await robot.mutation(api.clients.workerRegisterConnected, {
        userId,
        telegramId: `telegram:scroll-test-${Date.now()}`,
        kind: "Telegram",
      })
    );

    // Create test chat.
    chatId = `${clientId}:scroll-chat`;
    await robot.mutation(api.chats.upsert, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Scroll Test Chat",
      lastMessageTimestamp: Date.now(),
    });

    // Create 70 messages (PAGE_SIZE is 50, so messages 1–20 require a second page).
    // Messages sorted by ts desc → first page = messages 70–21, second page = 20–1.
    const baseTs = Date.now() - 400_000;
    for (let i = 1; i <= 70; i++) {
      const msgId = `${clientId}:${chatId}:msg-${i}`;
      await robot.mutation(api.messages.upsert, {
        messageId: msgId,
        externalId: `scroll-ext-${i}`,
        userId,
        clientId,
        chatId,
        senderId: "sender-1",
        text: `Test message number ${i}`,
        outgoing: i % 2 === 0,
        deleted: false,
        timestamp: baseTs + i * 5000,
      });
    }

    // Message 60 is in the first page (newest 50 are 21–70).
    firstPageTargetId = `${clientId}:${chatId}:msg-60`;
    // Message 10 is in the second page (requires loadMore).
    deepTargetId = `${clientId}:${chatId}:msg-10`;

    await page.close();
  });

  test.afterAll(async () => {
    if (!clientId) {
      return;
    }
    try {
      const robot = getRobotClient();
      await robot.mutation(api.clients.deleteClient, { clientId });
    } catch {
      // Best-effort cleanup.
    }
  });

  test("scrolls to a message in the first page", async ({ page }) => {
    await page.goto(
      `/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(firstPageTargetId)}`
    );

    // The target message should become visible.
    const targetEl = page.locator(`[data-message-id="${firstPageTargetId}"]`);
    await expect(targetEl).toBeVisible({ timeout: 20_000 });
    await expect(targetEl).toContainText("Test message number 60");

    // The highlight ring should be applied to the bubble.
    const bubble = targetEl.locator(".ring-primary");
    await expect(bubble).toBeVisible({ timeout: 5000 });
  });

  test("scrolls to a message requiring loadMore (second page)", async ({
    page,
  }) => {
    await page.goto(
      `/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(deepTargetId)}`
    );

    // This message is beyond the first page — the component must loadMore to find it.
    const targetEl = page.locator(`[data-message-id="${deepTargetId}"]`);
    await expect(targetEl).toBeVisible({ timeout: 30_000 });
    await expect(targetEl).toContainText("Test message number 10");
  });

  test("navigating to chat without messageId scrolls to bottom", async ({
    page,
  }) => {
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

    // The newest message (70) should be visible at the bottom.
    const newestEl = page.locator(
      `[data-message-id="${clientId}:${chatId}:msg-70"]`
    );
    await expect(newestEl).toBeVisible({ timeout: 20_000 });
    await expect(newestEl).toContainText("Test message number 70");
  });
});
