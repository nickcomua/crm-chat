import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { getSessionEnv } from "./env";
import {
  api,
  getConvexUserId,
  getRobotClient,
  getSessionPath,
  sanitizeOwnerId,
  seedTestClient,
} from "./helpers";

/**
 * Client Deletion Bug Test
 *
 * This test exposes a known bug: when a TG client is deleted via the UI/API,
 * the .session file persists on disk. On crm-worker restart,
 * `discover_and_register_sessions()` finds the orphaned session file and
 * re-creates the client via `workerRegisterConnected()`.
 *
 * Expected: After deletion, the client should NOT reappear.
 * Actual (bug): The client reappears after worker restart/discovery.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/#\/settings/;

test.describe.configure({ mode: "serial" });

const session = getSessionEnv();

let userId: string;

test.describe("Client Deletion — Backend Bug", () => {
  let clientId: string;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    await page.close();
  });

  test("delete client removes from DB", async () => {
    // Register a client
    clientId = await seedTestClient(
      userId,
      `telegram:deletion-test-${Date.now()}`
    );

    const robot = getRobotClient();

    // Verify it exists
    const before = await robot.query(api.clients.getForWorker, {
      clientId,
    });
    expect(before).toBeTruthy();

    // Delete it
    await robot.mutation(api.testHelpers.deleteClient, { clientId });

    // Verify it's gone
    const after = await robot.query(api.clients.getForWorker, { clientId });
    expect(after).toBeNull();
  });

  test("workerRegisterConnected re-creates deleted client with same telegramId (BUG)", async () => {
    /**
     * This test reproduces the bug: after deleting a client,
     * calling workerRegisterConnected with the same telegramId
     * creates a NEW client — simulating what happens when the worker
     * discovers an orphaned session file.
     *
     * This test is expected to PASS (demonstrating the bug EXISTS).
     * Once the bug is fixed (e.g., session cleanup on delete, or a
     * `deletedAt` flag that discovery respects), this test should be
     * updated to assert the opposite.
     */
    const telegramId = `telegram:deletion-bug-${Date.now()}`;

    // Step 1: Register client
    const robot = getRobotClient();
    const firstClientId = (await robot.mutation(api.clients.workerRegisterConnected, {
      userId,
      telegramId,
      kind: "Telegram",
    })) as string;
    expect(firstClientId).toBeTruthy();

    // Step 2: Delete client
    await robot.mutation(api.testHelpers.deleteClient, {
      clientId: firstClientId,
    });

    // Step 3: Verify deleted
    const deleted = await robot.query(api.clients.getForWorker, {
      clientId: firstClientId,
    });
    expect(deleted).toBeNull();

    // Step 4: Simulate worker discovery — register again with same telegramId
    const secondClientId = (await robot.mutation(api.clients.workerRegisterConnected, {
      userId,
      telegramId,
      kind: "Telegram",
    })) as string;

    // BUG: A new client is created (or the old one is patched back to Connected)
    // This should NOT happen if the bug were fixed
    expect(secondClientId).toBeTruthy();

    const revived = await robot.query(api.clients.getForWorker, {
      clientId: secondClientId,
    }) as { status: { type: string } } | null;
    expect(revived).toBeTruthy();
    expect(revived?.status.type).toBe("Connected");

    // Cleanup
    await robot.mutation(api.testHelpers.deleteClient, {
      clientId: secondClientId,
    });
  });
});

test.describe("Client Deletion — Session File Persistence", () => {
  test.skip(!session, "Skipping: TG_SESSION_FILE_1 not set");

  let clientId: string;
  let sessionPath: string;

  test.beforeAll(async ({ browser }) => {
    if (!session) return;

    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);

    // Copy a real session file to the worker's session directory
    const telegramId = `telegram:${session!.userId}`;
    sessionPath = getSessionPath(telegramId, userId);
    mkdirSync(path.dirname(sessionPath), { recursive: true });
    copyFileSync(session!.sessionFile, sessionPath);

    // Register the client
    clientId = (await getRobotClient().mutation(api.clients.workerRegisterConnected, {
      userId,
      telegramId,
      kind: "Telegram",
    })) as string;

    await page.close();
  });

  test.afterAll(async () => {
    if (clientId) {
      try {
        await getRobotClient().mutation(api.testHelpers.deleteClient, {
          clientId,
        });
      } catch {
        // best-effort
      }
    }
  });

  test("session file persists after client deletion (BUG)", async () => {
    if (!session || !sessionPath) return;

    // Verify session file exists before deletion
    expect(existsSync(sessionPath)).toBe(true);

    // Delete the client via API
    await getRobotClient().mutation(api.testHelpers.deleteClient, { clientId });

    // BUG: Session file still exists on disk after deletion
    // A proper fix would clean up the session file during deleteClient
    expect(existsSync(sessionPath)).toBe(true);
  });
});

test.describe("Client Deletion — UI", () => {
  let testClientId: string;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    testClientId = await seedTestClient(
      userId,
      `telegram:del-ui-${Date.now()}`
    );

    await page.close();
  });

  test("deleting client via UI removes it from settings list", async ({ page }) => {
    await page.goto("/#/settings");
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

    // Wait for client cards to load
    await expect(page.locator("text=Connected").first()).toBeVisible({ timeout: 10_000 });

    // Count initial client cards
    const initialCards = await page.locator(".group").count();

    // Hover over the last card (our test client) and click delete
    const lastCard = page.locator(".group").last();
    await lastCard.hover();

    // Click the delete button (last button with SVG in the hover group)
    const deleteBtn = lastCard.locator("button").last();
    await deleteBtn.click();

    // Wait for the card to disappear — either fewer cards or the specific one is gone
    await page.waitForTimeout(2000);

    const finalCards = await page.locator(".group").count();
    expect(finalCards).toBeLessThan(initialCards);
  });
});
