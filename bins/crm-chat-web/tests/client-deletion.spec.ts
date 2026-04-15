import { expect, test } from "./fixtures";
import {
  api,
  getConvexUserId,
  getRobotClient,
  type Id,
  seedTestClient,
  type WorkerConfig,
} from "./helpers";

/**
 * Client Deletion Tests
 *
 * The core bug: deleteClient() removes the DB record but leaves the
 * .session file on disk. When crm-worker restarts, discover_and_register_sessions()
 * finds the orphaned session and calls workerRegisterConnected(), which blindly
 * recreates the client. workerRegisterConnected has zero awareness of deletions.
 *
 * The "worker re-registration" test below asserts CORRECT behavior and is
 * expected to FAIL until the bug is fixed.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/#\/settings/;

test.describe.configure({ mode: "serial" });

let userId: string;
let workerCfg: WorkerConfig;

test.beforeAll(async ({ browser, workerBackend }) => {
  workerCfg = workerBackend;
  const context = await browser.newContext({
    storageState: "tests/.auth/user.json",
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
  userId = await getConvexUserId(page);
  await context.close();
});

test.describe("Client Deletion", () => {
  /**
   * workerRegisterConnected must refuse to recreate a deleted client.
   *
   * Scenario: User deletes a client → worker restarts → worker calls
   * workerRegisterConnected with the same telegramId (orphaned .session
   * file still on disk) → tombstone blocks re-creation, returns null.
   */
  test("deleted client must not be recreated by worker re-registration", async () => {
    const telegramId = `telegram:deletion-bug-${Date.now()}`;
    const robot = await getRobotClient(workerCfg);

    // 1. Worker discovers a session file and registers the client
    const clientId = (await robot.mutation(
      api.model.clients.workerRegisterConnected,
      { userId, telegramId, kind: "Telegram" }
    )) as Id<"clients">;

    // 2. User deletes the client (writes a tombstone)
    await robot.mutation(api.testHelpers.deleteClient, { clientId });

    // 3. Verify deletion succeeded
    const afterDelete = await robot.query(api.model.clients.getForWorker, {
      clientId,
    });
    expect(afterDelete).toBeNull();

    // 4. Worker restarts — rediscovers the same .session file on disk
    //    and calls workerRegisterConnected again with the same telegramId.
    //    Tombstone blocks re-creation — returns null.
    const result = await robot.mutation(
      api.model.clients.workerRegisterConnected,
      { userId, telegramId, kind: "Telegram" }
    );
    expect(result).toBeNull();
  });

  test("deleting client via UI removes it from settings list", async ({
    page,
  }) => {
    const robot = await getRobotClient(workerCfg);
    const testTelegramId = `telegram:del-ui-${Date.now()}`;
    await seedTestClient(userId, testTelegramId, robot);

    await page.goto("/#/settings");
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

    await expect(page.locator("text=Connected").first()).toBeVisible({
      timeout: 10_000,
    });

    // Verified: telegram-clients-manager.tsx:197 — data-testid="client-card"
    const cardSelector = '[data-testid="client-card"]';
    const targetCard = page.locator(cardSelector, {
      hasText: testTelegramId,
    });
    await expect(targetCard).toBeVisible({ timeout: 10_000 });

    const initialCards = await page.locator(cardSelector).count();

    await targetCard.hover();
    // Verified: telegram-clients-manager.tsx:227 — aria-label="Delete client"
    const deleteBtn = targetCard.locator('button[aria-label="Delete client"]');
    await deleteBtn.click();

    // After adding confirmation dialog additional steps are required
    const confirmBtn = page.locator('button[aria-label="Confirm deletion"]');
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();

    await expect(targetCard).toBeHidden({ timeout: 10_000 });

    const finalCards = await page.locator(cardSelector).count();
    expect(finalCards).toBeLessThan(initialCards);
  });
});
