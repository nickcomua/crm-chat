import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { env } from "../env";
import { expect, test } from "../fixtures";
import {
  api,
  getConvexUserId,
  getRobotClient,
  getSessionPath,
  type Id,
  pollUntil,
  type WorkerConfig,
  writeOwnerFile,
} from "../helpers";

const SETTINGS_URL_PATTERN = /\/settings/;
const CHATS_URL_PATTERN = /\/#\/chats/;

// Run tests sequentially — they share a single Clerk test account and TG client
test.describe.configure({ mode: "serial" });

let registeredClientId: Id<"clients">;
let copiedSessionPath: string;
let convexUserId: string;
let workerCfg: WorkerConfig;

test.describe("Client Settings & Chat Scanning", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;

    // Load storageState explicitly — browser.newPage() doesn't inherit project-level storageState
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    convexUserId = await getConvexUserId(page);

    // Place session file where the subscriber expects it (same path logic as Rust)
    const telegramId = `telegram:${env.TG_USER_ID_1}`;
    copiedSessionPath = getSessionPath(
      telegramId,
      convexUserId,
      workerCfg.sessionDir
    );
    mkdirSync(path.dirname(copiedSessionPath), { recursive: true });
    copyFileSync(env.TG_SESSION_FILE_1, copiedSessionPath);
    writeOwnerFile(copiedSessionPath, convexUserId);

    // Register the TG client as Connected — subscriber picks it up and starts scanning
    const robot = getRobotClient(workerCfg);
    registeredClientId = (await robot.mutation(
      api.clients.workerRegisterConnected,
      {
        userId: convexUserId,
        telegramId,
        kind: "Telegram",
      }
    )) as Id<"clients">;

    // Enable scanning on first 3 chats immediately after registration.
    // This gives ChatScanner tasks a ~15s head start (time of tests 1-5)
    // so scanning is complete by the time "show loaded messages" test runs.
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });
    const toggles = page.locator('button[aria-label^="Toggle scanning for"]');
    await expect(toggles.first()).toBeVisible({ timeout: 10_000 });

    const enableCount = Math.min(3, await toggles.count());
    for (let i = 0; i < enableCount; i++) {
      const checked = await toggles.nth(i).getAttribute("aria-checked");
      if (checked !== "true") {
        await toggles.nth(i).click();
        await expect(toggles.nth(i)).toHaveAttribute("aria-checked", "true", {
          timeout: 5000,
        });
      }
    }

    await page.close();
  });

  test("settings page shows connected client with settings button", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Navigate to settings
    await page.locator('a[href="/#/settings"]').click({ timeout: 10_000 });
    await page.waitForURL(SETTINGS_URL_PATTERN);
    await page.waitForSelector("text=Telegram Clients", { timeout: 10_000 });

    // The registered client should appear as Connected with a settings button
    const settingsButton = page.locator('button[aria-label="Client settings"]');
    await expect(settingsButton.first()).toBeVisible({ timeout: 10_000 });
  });

  test("client settings page shows chats synced by subscriber", async ({
    page,
  }) => {
    // Navigate directly to the client settings page
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Wait for at least one chat to appear (subscriber syncs Telegram dialogs)
    const chatRows = page.locator(".divide-y > div");
    await expect(chatRows.first()).toBeVisible({ timeout: 10_000 });

    // Verify at least one chat row has a name
    const chatCount = await chatRows.count();
    expect(chatCount).toBeGreaterThan(0);
  });

  test("can toggle scan enabled for a chat", async ({ page }) => {
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Wait for chats to load
    const chatRows = page.locator(".divide-y > div");
    await expect(chatRows.first()).toBeVisible({ timeout: 10_000 });

    // Find any scan toggle button
    const toggleButton = page.locator(
      'button[aria-label^="Toggle scanning for"]'
    );
    await expect(toggleButton.first()).toBeVisible({ timeout: 10_000 });

    // Get current state and toggle
    const currentState = await toggleButton
      .first()
      .getAttribute("aria-checked");
    await toggleButton.first().click();

    // Verify state changed
    const expectedState = currentState === "true" ? "false" : "true";
    await expect(toggleButton.first()).toHaveAttribute(
      "aria-checked",
      expectedState,
      { timeout: 5000 }
    );
  });

  test("can edit pinned name inline", async ({ page }) => {
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Wait for chats to load
    const chatRows = page.locator(".divide-y > div");
    await expect(chatRows.first()).toBeVisible({ timeout: 10_000 });

    // Click on the first chat name button to start editing
    const chatName = chatRows.first().locator("button.group");
    await chatName.click();

    // An input should appear
    const nameInput = page.locator('input[placeholder="Custom name..."]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });

    // Type a new name and confirm
    const testName = `E2E Test ${Date.now()}`;
    await nameInput.fill(testName);
    await nameInput.press("Enter");

    // The input should disappear and the new name should be shown
    await expect(nameInput).toBeHidden({ timeout: 5000 });
    await expect(page.locator(`text=${testName}`)).toBeVisible();
  });

  test("chats page shows only scan-enabled chats", async ({ page }) => {
    // First, go to client settings and count scan-enabled chats
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });
    const chatRows = page.locator(".divide-y > div");
    await expect(chatRows.first()).toBeVisible({ timeout: 10_000 });

    // Count how many toggles are checked (scanEnabled)
    const toggles = page.locator('button[aria-label^="Toggle scanning for"]');
    const toggleCount = await toggles.count();
    let enabledCount = 0;
    for (let i = 0; i < toggleCount; i++) {
      const checked = await toggles.nth(i).getAttribute("aria-checked");
      if (checked === "true") {
        enabledCount++;
      }
    }

    // Navigate to chats page — only scan-enabled chats should appear
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    if (enabledCount > 0) {
      // Chat list items are buttons inside .space-y-px
      const chatListItems = page.locator(".space-y-px > button");
      await expect(chatListItems.first()).toBeVisible({ timeout: 10_000 });
      const visibleChats = await chatListItems.count();
      // Use >= because parallel test workers may create additional scan-enabled chats
      expect(visibleChats).toBeGreaterThanOrEqual(enabledCount);
    } else {
      // No scan-enabled chats — should show "No chats yet" or empty state
      await expect(page.locator("text=No chats yet")).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test("at least 1 chat has scanned messages", async ({ page }) => {
    // Scanning was enabled in beforeAll — by now (after 5 earlier serial tests),
    // the worker should have completed scanning at least 1 chat.
    // With qr-auth moved to sequential chain, no parallel specs compete for worker.
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Wait for at least 1 chat to be fully scanned (fullScanned=true → "Synced" badge).
    const syncedBadges = page.locator("text=Synced");
    await pollUntil(page, async () => (await syncedBadges.count()) >= 1, 1000);

    // Verify messages exist via robot API — query actual messages in the DB
    // rather than relying on the syncedMessages counter (which may not be set
    // if the final updateSyncProgress mutation races with task completion).
    const robot = getRobotClient(workerCfg);
    const allChats = (await robot.query(api.testHelpers.queryChats, {
      userId: convexUserId,
    })) as Array<{
      chatId: string;
      clientId: string;
      fullScanned?: boolean;
    }>;
    const clientChats = allChats.filter(
      (c) => c.clientId === registeredClientId && c.fullScanned
    );

    let chatsWithMessages = 0;
    for (const chat of clientChats) {
      const messages = (await robot.query(api.testHelpers.queryMessages, {
        chatId: chat.chatId,
        limit: 1,
      })) as unknown[];
      if (messages.length > 0) {
        chatsWithMessages++;
      }
    }
    expect(chatsWithMessages).toBeGreaterThanOrEqual(1);
  });

  test("real Telegram forwarded messages have forwardedFrom metadata", async () => {
    // Known gap: the Rust extraction pipeline does not yet populate forwardedFrom.
    // This test documents the gap and will start passing once implemented.
    test.fail();

    // The "Test" chat in real Telegram data contains forwarded messages.
    // The worker pipeline (MessageSummary → workerOps.upsertMessage) should
    // extract Telegram's fwd_from header and store it as forwardedFrom.
    //
    // THIS TEST IS EXPECTED TO FAIL until the extraction pipeline is
    // implemented: MessageSummary needs a forwardedFrom field, the
    // Telegram parser must call msg.forward_header(), and
    // workerOps.upsertMessage must accept and store forwardedFrom.
    const robot = getRobotClient(workerCfg);
    const allChats = (await robot.query(api.testHelpers.queryChats, {
      userId: convexUserId,
    })) as Array<{
      chatId: string;
      clientId: string;
      fullScanned?: boolean;
      pinnedName?: string;
    }>;

    // Find a fully scanned chat from our client
    const scannedChats = allChats.filter(
      (c) => c.clientId === registeredClientId && c.fullScanned
    );
    expect(scannedChats.length).toBeGreaterThan(0);

    // Query messages across all scanned chats, looking for any with forwardedFrom
    let totalMessages = 0;
    let forwardedCount = 0;

    for (const chat of scannedChats) {
      const messages = (await robot.query(api.testHelpers.queryMessages, {
        chatId: chat.chatId,
        limit: 200,
      })) as Array<{
        messageId: string;
        text?: string;
        forwardedFrom?: { senderName: string; date?: number };
      }>;
      totalMessages += messages.length;
      forwardedCount += messages.filter((m) => m.forwardedFrom).length;
    }

    // At least some messages should have forwarded metadata.
    // Telegram chats commonly contain forwarded messages, especially the
    // "Test" chat which is known to have many forwards near the end.
    expect(totalMessages).toBeGreaterThan(0);
    // At least 1 message should have forwardedFrom. If this fails, the worker
    // pipeline does not extract Telegram's fwd_from header.
    expect(forwardedCount).toBeGreaterThan(0);
  });

  test("rescan button triggers new scan", async ({ page }) => {
    // Navigate to client settings and wait for a scan-enabled chat to finish
    // (Rescan only appears when scanEnabled AND fullScanned are both true)
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    const rescanButton = page.locator('button:has-text("Rescan")');
    await pollUntil(page, async () => (await rescanButton.count()) >= 1, 1000);

    // Click Rescan — this resets fullScanned and enqueues a new ChatScanner task
    await rescanButton.first().click();

    // Verify the mutation took effect by checking the DB directly.
    // The mutation atomically sets fullScanned=false; the scanner takes
    // seconds to restore it, giving us a window to observe the reset.
    // NOTE: We can't rely on the UI button disappearing because Convex may
    // batch the reactive updates (mutation + scanner completion) into a
    // single WebSocket message, so the UI never shows the intermediate state.
    const robot = getRobotClient(workerCfg);
    await pollUntil(
      page,
      async () => {
        const chats = (await robot.query(api.testHelpers.queryChats, {
          userId: convexUserId,
        })) as Array<{
          chatId: string;
          clientId: string;
          fullScanned?: boolean;
        }>;
        return chats.some(
          (c) => c.clientId === registeredClientId && !c.fullScanned
        );
      },
      200
    );
  });

  test("toggling scan off then on triggers fresh scan", async ({ page }) => {
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Find a scan-enabled chat (toggle is checked)
    const toggles = page.locator('button[aria-label^="Toggle scanning for"]');
    await expect(toggles.first()).toBeVisible({ timeout: 10_000 });

    // Find a toggle that is currently ON
    let targetIndex = -1;
    const count = await toggles.count();
    for (let i = 0; i < count; i++) {
      if ((await toggles.nth(i).getAttribute("aria-checked")) === "true") {
        targetIndex = i;
        break;
      }
    }
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    // Toggle OFF
    await toggles.nth(targetIndex).click();
    await expect(toggles.nth(targetIndex)).toHaveAttribute(
      "aria-checked",
      "false",
      { timeout: 5000 }
    );

    // Toggle back ON — should trigger a fresh scan (fullScanned was reset)
    await toggles.nth(targetIndex).click();
    await expect(toggles.nth(targetIndex)).toHaveAttribute(
      "aria-checked",
      "true",
      { timeout: 5000 }
    );

    // Verify scanning state appears (not waiting for full completion)
    const scanningBadge = page.locator("text=/Scanning|Syncing|Listening/");
    await expect(scanningBadge.first()).toBeVisible({ timeout: 10_000 });
  });

  test("back button navigates to settings page", async ({ page }) => {
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Click the back button
    await page.click('button[aria-label="Back to settings"]');

    // Should navigate back to settings
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });
    await expect(page.locator("text=Telegram Clients")).toBeVisible();
  });
});
