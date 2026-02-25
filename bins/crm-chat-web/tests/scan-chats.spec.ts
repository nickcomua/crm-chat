import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { getSessionEnv } from "./env";
import { api, getConvexUserId, getRobotClient, unwrapResult } from "./helpers";

/** Mirror Rust's sanitize_owner_id: replace non-alphanumeric (except - _) with _ */
function sanitizeOwnerId(ownerId: string): string {
  return ownerId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Mirror Rust's sanitize for session paths: keep only digits and + */
function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^0-9+]/g, "");
}

/** Compute session file path using E2E_SESSION_DIR (mirrors Rust's get_session_path) */
function getSessionPath(identifier: string, ownerId: string): string {
  const baseDir = process.env.E2E_SESSION_DIR;
  if (!baseDir) {
    throw new Error("E2E_SESSION_DIR not set — is globalSetup running?");
  }
  const dir = path.join(baseDir, sanitizeOwnerId(ownerId));
  return path.join(dir, `${sanitizeIdentifier(identifier)}.session`);
}

const SETTINGS_URL_PATTERN = /\/settings/;
const CHATS_URL_PATTERN = /\/#\/chats/;

// Run tests sequentially — they share a single Clerk test account and TG client
test.describe.configure({ mode: "serial" });

const session = getSessionEnv();

let registeredClientId: string | null = null;
let copiedSessionPath: string | null = null;

test.describe("Client Settings & Chat Scanning", () => {
  test.beforeAll(async ({ browser }) => {
    if (!session) {
      return;
    }

    // Load storageState explicitly — browser.newPage() doesn't inherit project-level storageState
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    const convexUserId = await getConvexUserId(page);

    // Place session file where the subscriber expects it (same path logic as Rust)
    const telegramId = `telegram:${session.userId}`;
    copiedSessionPath = getSessionPath(telegramId, convexUserId);
    mkdirSync(path.dirname(copiedSessionPath), { recursive: true });
    copyFileSync(session.sessionFile, copiedSessionPath);

    // Register the TG client as Connected — subscriber picks it up and starts scanning
    const robot = getRobotClient();
    registeredClientId = unwrapResult<string>(
      await robot.mutation(api.clients.workerRegisterConnected, {
        userId: convexUserId,
        telegramId,
        kind: "Telegram",
      })
    );

    await page.close();
  });

  test.afterAll(async () => {
    // Best-effort cleanup of the registered client
    if (registeredClientId) {
      try {
        const robot = getRobotClient();
        await robot.mutation(api.clients.deleteClient, {
          clientId: registeredClientId,
        });
      } catch {
        // cleanup is best-effort
      }
    }
    // Clean up the copied session file
    if (copiedSessionPath) {
      try {
        rmSync(copiedSessionPath, { force: true });
      } catch {
        // cleanup is best-effort
      }
    }
  });

  test("settings page shows connected client with settings button", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

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
    await page.waitForTimeout(1000);

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

  test("at least 2 chats show loaded messages", async ({ page }) => {
    // This test waits for real Telegram scanning — allow extra time for
    // Phase 4 refresh cycle to pick up newly-enabled chats and scan them.
    test.setTimeout(60_000);
    // Enable scan on at least 2 chats via client settings
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    const toggles = page.locator('button[aria-label^="Toggle scanning for"]');
    await expect(toggles.first()).toBeVisible({ timeout: 10_000 });

    for (let i = 0; i < 2; i++) {
      const checked = await toggles.nth(i).getAttribute("aria-checked");
      if (checked !== "true") {
        await toggles.nth(i).click();
        await expect(toggles.nth(i)).toHaveAttribute("aria-checked", "true", {
          timeout: 5000,
        });
      }
    }

    // Wait for subscriber to backfill messages — "Listening" badge appears when the worker
    // has finished scanning and entered the real-time update listener (Phase 4).
    // The UI shows "Listening" (not "Synced") because the active scanPhase takes precedence.
    // Poll with short waits since this is network-dependent (Telegram scan).
    const listeningBadges = page.locator("text=Listening");
    await pollUntil(page, () => listeningBadges.nth(1).isVisible());

    // Open each synced chat and verify it has at least 1 message
    for (let i = 0; i < 2; i++) {
      await page.goto("/");
      await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

      const chatListItems = page.locator(".space-y-px > button");
      await expect(chatListItems.nth(i)).toBeVisible({ timeout: 10_000 });
      await chatListItems.nth(i).click();

      // Wait for "N message(s)" where N >= 1
      const messageHeader = page.locator("text=/[1-9]\\d* messages?/");
      await expect(messageHeader).toBeVisible({ timeout: 10_000 });
    }
  });

  test("rescan button triggers new scan", async ({ page }) => {
    test.setTimeout(60_000);

    // Navigate to client settings and wait for a "Synced" chat with Rescan button
    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    const rescanButton = page.locator('button:has-text("Rescan")');
    await expect(rescanButton.first()).toBeVisible({ timeout: 10_000 });

    // Click Rescan — this resets fullScanned and enqueues a new ChatScanner task
    await rescanButton.first().click();

    // The "Synced" badge for this chat should disappear (fullScanned → false)
    // and eventually reappear once the scanner completes
    await expect(rescanButton.first()).toBeHidden({ timeout: 10_000 });

    // Wait for it to become Synced again (the scan re-runs) — network-dependent
    await pollUntil(page, () => rescanButton.first().isVisible());
  });

  test("toggling scan off then on triggers fresh scan", async ({ page }) => {
    test.setTimeout(60_000);

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

    // The chat should eventually reach "Synced" again (Rescan button appears)
    // Network-dependent — poll with short waits
    const rescanButtons = page.locator('button:has-text("Rescan")');
    await pollUntil(page, () => rescanButtons.first().isVisible());
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

/**
 * Poll a condition with 5s sleeps between attempts.
 * Individual checks are instant; the overall wait is bounded by test.setTimeout.
 */
async function pollUntil(
  page: import("@playwright/test").Page,
  condition: () => Promise<boolean>,
  intervalMs = 5000
): Promise<void> {
  while (!(await condition())) {
    await page.waitForTimeout(intervalMs);
  }
}
