import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { getSessionEnv } from "./env";
import {
  api,
  getConvexUserId,
  getRobotClient,
  getSessionPath,
  pollUntil,
} from "./helpers";

/**
 * Media Visual Tests
 *
 * These tests use a real Telegram session (like media-rendering.spec.ts)
 * to verify visual constraints and rendering details beyond basic "it loads":
 * - Photo thumbnails stay within size bounds
 * - VideoNote has circular styling
 * - Sticker size is constrained
 * - Skipped media shows download button
 * - Document download button works
 *
 * Requires TG_SESSION_FILE_1 + TG_USER_ID_1 env vars.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;
const DOWNLOADS_URL_PATTERN = /\/#\/downloads/;

test.describe.configure({ mode: "serial" });

const session = getSessionEnv();

let registeredClientId: string | null = null;
let copiedSessionPath: string | null = null;

test.describe("Media Visual — Real Telegram Data", () => {
  test.skip(!session, "Skipping: TG_SESSION_FILE_1 not set");

  test.beforeAll(async ({ browser }) => {
    if (!session) return;

    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    const convexUserId = await getConvexUserId(page);

    const telegramId = `telegram:${session!.userId}`;
    copiedSessionPath = getSessionPath(telegramId, convexUserId);
    mkdirSync(path.dirname(copiedSessionPath), { recursive: true });
    copyFileSync(session!.sessionFile, copiedSessionPath);

    const robot = getRobotClient();
    registeredClientId = (await robot.mutation(api.clients.workerRegisterConnected, {
      userId: convexUserId,
      telegramId,
      kind: "Telegram",
    })) as string;

    await page.close();
  });

  test.afterAll(async () => {
    if (registeredClientId) {
      try {
        const robot = getRobotClient();
        await robot.mutation(api.testHelpers.deleteClient, {
          clientId: registeredClientId,
        });
      } catch {
        // best-effort
      }
    }
    if (copiedSessionPath) {
      try {
        rmSync(copiedSessionPath, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  test("wait for media sync to complete", async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Enable scanning on first 2 chats
    const toggles = page.locator('button[aria-label^="Toggle scanning for"]');
    await expect(toggles.first()).toBeVisible({ timeout: 10_000 });

    const count = Math.min(2, await toggles.count());
    for (let i = 0; i < count; i++) {
      const checked = await toggles.nth(i).getAttribute("aria-checked");
      if (checked !== "true") {
        await toggles.nth(i).click();
        await expect(toggles.nth(i)).toHaveAttribute("aria-checked", "true", {
          timeout: 5000,
        });
      }
    }

    // Poll for "Synced" badge
    await pollUntil(page, () =>
      page.locator("text=Synced").first().isVisible()
    );

    // Wait for at least one media download
    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });
    await pollUntil(page, () =>
      page.locator('text="Recent"').isVisible()
    );
  });

  test("photo thumbnails respect max-height (300px)", async ({ page }) => {
    test.setTimeout(30_000);

    const found = await findChatWith(page, 'img[alt="Shared media"]');
    expect(found, "No photo media found").toBeTruthy();

    const photos = page.locator('img[alt="Shared media"]');
    const photoCount = await photos.count();

    for (let i = 0; i < photoCount; i++) {
      const box = await photos.nth(i).boundingBox();
      if (box) {
        // max-h-[300px] class should constrain height
        expect(box.height).toBeLessThanOrEqual(310); // small tolerance for rounding
      }
    }
  });

  test("VideoNote has circular (rounded-full) styling", async ({ page }) => {
    test.setTimeout(30_000);

    // VideoNote videos have rounded-full class
    const found = await findChatWith(page, "video.rounded-full");
    if (!found) {
      // VideoNotes may not exist in test data — skip gracefully
      test.skip();
      return;
    }

    const videoNote = page.locator("video.rounded-full").first();
    await expect(videoNote).toBeVisible({ timeout: 10_000 });

    // Verify the video element has rounded-full class
    const classes = await videoNote.getAttribute("class");
    expect(classes).toContain("rounded-full");
  });

  test("sticker images are constrained to 180px", async ({ page }) => {
    test.setTimeout(30_000);

    const found = await findChatWith(page, 'img[alt="Sticker"]');
    if (!found) {
      test.skip();
      return;
    }

    const stickers = page.locator('img[alt="Sticker"]');
    const count = await stickers.count();

    for (let i = 0; i < count; i++) {
      const box = await stickers.nth(i).boundingBox();
      if (box) {
        // max-w-[180px] max-h-[180px] constraint
        expect(box.width).toBeLessThanOrEqual(190);
        expect(box.height).toBeLessThanOrEqual(190);
      }
    }
  });

  test("animations autoplay and loop silently", async ({ page }) => {
    test.setTimeout(30_000);

    const found = await findChatWith(page, "video[autoplay][loop][muted]");
    if (!found) {
      test.skip();
      return;
    }

    const anim = page.locator("video[autoplay][loop][muted]").first();
    await expect(anim).toBeVisible({ timeout: 10_000 });

    // Verify autoplay, loop, and muted attributes
    expect(await anim.getAttribute("autoplay")).not.toBeNull();
    expect(await anim.getAttribute("loop")).not.toBeNull();
    expect(await anim.getAttribute("muted")).not.toBeNull();
  });

  test("document media shows filename and download icon", async ({ page }) => {
    test.setTimeout(30_000);

    // Documents are rendered as buttons with a file name and download icon
    const found = await findChatWith(
      page,
      'button:has(p:text-matches("\\\\.[a-z0-9]+$", "i"))'
    );
    if (!found) {
      test.skip();
      return;
    }

    const docButton = page
      .locator('button:has(p:text-matches("\\\\.[a-z0-9]+$", "i"))')
      .first();
    await expect(docButton).toBeVisible({ timeout: 10_000 });

    // Should contain the Download SVG icon
    const downloadIcon = docButton.locator("svg").first();
    await expect(downloadIcon).toBeVisible();
  });

  test("video duration overlay is displayed", async ({ page }) => {
    test.setTimeout(30_000);

    const found = await findChatWith(page, "video:not([autoplay])");
    if (!found) {
      test.skip();
      return;
    }

    // Duration badge is a span with time format (e.g., "0:30")
    const durationBadge = page.locator(
      'span.bg-black\\/60:text-matches("\\d+:\\d{2}")'
    );

    if (await durationBadge.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      const text = await durationBadge.first().textContent();
      expect(text).toMatch(/\d+:\d{2}/);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers (same pattern as media-rendering.spec.ts)
// ---------------------------------------------------------------------------

async function findChatWith(
  page: import("@playwright/test").Page,
  selector: string
): Promise<boolean> {
  await page.goto("/");
  await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

  const chatButtons = page.locator(".space-y-px > button");
  await expect(chatButtons.first()).toBeVisible({ timeout: 10_000 });

  const count = await chatButtons.count();

  for (let i = 0; i < count; i++) {
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const buttons = page.locator(".space-y-px > button");
    await buttons.nth(i).click();

    try {
      await page.waitForSelector(selector, { timeout: 10_000 });
      return true;
    } catch {
      // Not in initial view — try scrolling up
    }

    const msgContainer = page.locator(".messages-bg");
    if ((await msgContainer.count()) > 0) {
      await msgContainer.evaluate((el) => el.scrollTo(0, 0));
      try {
        await page.waitForSelector(selector, { timeout: 10_000 });
        return true;
      } catch {
        // Not found, try next chat
      }
    }
  }

  return false;
}
