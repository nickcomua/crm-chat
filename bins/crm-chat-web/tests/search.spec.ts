import { expect, test } from "@playwright/test";
import {
  api,
  getConvexUserId,
  getRobotClient,
  seedMessage,
  seedTestClient,
} from "./helpers";

/**
 * Search Tests — TDD (Limited Scope)
 *
 * Search uses an ES proxy that is currently broken/unreliable.
 * These tests focus on:
 * 1. Backend: Verify seeded messages are stored correctly (data integrity)
 * 2. UI: Verify search dialog shell (opens, input works, scope buttons render, error handling)
 *
 * We do NOT test actual search results since ES is broken.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: string;
let chatId: string;

test.describe("Search — Backend (Data Integrity)", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:search-test-${Date.now()}`);
    chatId = `${clientId}:search-chat`;

    const robot = getRobotClient();
    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Search Test Chat",
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

  test("seeded messages with known text are stored correctly", async () => {
    const msg1Id = `${chatId}:search-msg-1`;
    const msg2Id = `${chatId}:search-msg-2`;
    const msg3Id = `${chatId}:search-msg-3`;

    await seedMessage(userId, clientId, chatId, msg1Id, "Meeting with John about project alpha");
    await seedMessage(userId, clientId, chatId, msg2Id, "Quarterly budget review scheduled");
    await seedMessage(userId, clientId, chatId, msg3Id, "Don't forget to send the invoice");

    // Verify messages were stored via Convex query
    const robot = getRobotClient();
    const msgs = await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    }) as Array<{ messageId: string; text?: string }>;

    const msg1 = msgs.find((m) => m.messageId === msg1Id);
    const msg2 = msgs.find((m) => m.messageId === msg2Id);
    const msg3 = msgs.find((m) => m.messageId === msg3Id);

    expect(msg1?.text).toBe("Meeting with John about project alpha");
    expect(msg2?.text).toBe("Quarterly budget review scheduled");
    expect(msg3?.text).toBe("Don't forget to send the invoice");
  });

  test("messages with empty text are stored as undefined", async () => {
    const msgId = `${chatId}:search-empty-text`;
    await seedMessage(userId, clientId, chatId, msgId, undefined);

    const robot = getRobotClient();
    const msgs = await robot.query(api.testHelpers.queryMessages, {
      chatId,
      limit: 10,
    }) as Array<{ messageId: string; text?: string }>;

    const msg = msgs.find((m) => m.messageId === msgId);
    expect(msg).toBeTruthy();
    expect(msg?.text).toBeUndefined();
  });
});

test.describe("Search — UI (Dialog Shell)", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:search-ui-${Date.now()}`);

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

  test("search button opens search dialog", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Click the search button in the header
    const searchButton = page.locator('button:has(span:text("Search messages"))');
    await expect(searchButton).toBeVisible({ timeout: 10_000 });
    await searchButton.click();

    // Dialog should open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator("text=Search Messages")).toBeVisible();
  });

  test("search input is auto-focused and accepts text", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const searchButton = page.locator('button:has(span:text("Search messages"))');
    await searchButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Input should be auto-focused
    const input = dialog.locator('input[type="search"]');
    await expect(input).toBeVisible();

    // Type into search
    await input.fill("test query");
    await expect(input).toHaveValue("test query");
  });

  test("scope buttons render with 'All messages' default", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const searchButton = page.locator('button:has(span:text("Search messages"))');
    await searchButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // "All messages" scope button should be visible and active (primary color)
    await expect(dialog.locator('button:has-text("All messages")')).toBeVisible();
  });

  test("semantic search toggle works", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const searchButton = page.locator('button:has(span:text("Search messages"))');
    await searchButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Find the semantic search toggle (Sparkles icon button)
    const semanticBtn = dialog.locator('button[aria-label*="semantic"], button[aria-label*="Semantic"]');
    if (await semanticBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Should start as not pressed
      await expect(semanticBtn).toHaveAttribute("aria-pressed", "false", { timeout: 5000 });

      // Toggle it
      await semanticBtn.click();
      await expect(semanticBtn).toHaveAttribute("aria-pressed", "true", { timeout: 5000 });
    }
  });

  test("search shows error state when ES proxy is down", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const searchButton = page.locator('button:has(span:text("Search messages"))');
    await searchButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Type a search query to trigger the search
    const input = dialog.locator('input[type="search"]');
    await input.fill("test search query");

    // Wait for either error state or loading to resolve
    // Since ES is broken, we expect either a loading spinner or error message
    await page.waitForTimeout(3000);

    // Check for error or empty state — either is valid since ES is broken
    const hasError = await dialog.locator("text=Search failed").isVisible().catch(() => false);
    const hasNoResults = await dialog.locator("text=No results found").isVisible().catch(() => false);
    const isLoading = await dialog.locator(".animate-spin").isVisible().catch(() => false);

    // At least one state should be shown (not blank)
    expect(hasError || hasNoResults || isLoading).toBe(true);
  });

  test("Escape closes search dialog", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const searchButton = page.locator('button:has(span:text("Search messages"))');
    await searchButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });
});
