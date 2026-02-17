import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { getSessionEnv } from "./env";
import { api, getConvexUserId, getRobotClient, unwrapResult } from "./helpers";

/** Mirror Rust's sanitize_owner_id */
function sanitizeOwnerId(ownerId: string): string {
  return ownerId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Mirror Rust's sanitize for session paths */
function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^0-9+]/g, "");
}

function getSessionPath(identifier: string, ownerId: string): string {
  const baseDir = process.env.E2E_SESSION_DIR;
  if (!baseDir) {
    throw new Error("E2E_SESSION_DIR not set — is globalSetup running?");
  }
  const dir = path.join(baseDir, sanitizeOwnerId(ownerId));
  return path.join(dir, `${sanitizeIdentifier(identifier)}.session`);
}

const CHATS_URL_PATTERN = /\/#\/chats/;
const FILE_EXTENSION_RE = /\.[a-z0-9]+$/i;
const VIDEO_MIME_RE = /^video\//;
const DOWNLOADS_URL_PATTERN = /\/#\/downloads/;

// Run tests sequentially — they depend on subscriber sync completing first
test.describe.configure({ mode: "serial" });

const session = getSessionEnv();

let registeredClientId: string | null = null;
let copiedSessionPath: string | null = null;

test.describe("Media Rendering — Real Telegram Data", () => {
  test.beforeAll(async ({ browser }) => {
    if (!session) {
      return;
    }

    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    const convexUserId = await getConvexUserId(page);

    const telegramId = `telegram:${session.userId}`;
    copiedSessionPath = getSessionPath(telegramId, convexUserId);
    mkdirSync(path.dirname(copiedSessionPath), { recursive: true });
    copyFileSync(session.sessionFile, copiedSessionPath);

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
    if (registeredClientId) {
      try {
        const robot = getRobotClient();
        await robot.mutation(api.clients.deleteClient, {
          clientId: registeredClientId,
        });
      } catch {
        // best-effort cleanup
      }
    }
    if (copiedSessionPath) {
      try {
        rmSync(copiedSessionPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  test("enable scanning and wait for sync + media download", async ({
    page,
  }) => {
    test.setTimeout(300_000); // overall budget for real Telegram network ops

    await page.goto(`/#/client/${registeredClientId}`);
    await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });

    // Enable scanning on the first 2 chats
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

    // Poll for "Synced" badge — network-dependent (Telegram message scan)
    await pollUntil(page, () =>
      page.locator("text=Synced").first().isVisible()
    );

    // Poll Downloads page until at least one media is stored.
    // This confirms the full pipeline completed: scan → enqueue → download → upload.
    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });
    await pollUntil(page, () => {
      const recentSection = page.locator('text="Recent"');
      return recentSection.isVisible();
    });

    // Now find media in a chat — downloads are confirmed done, so 10s is enough
    const anyMediaSelector =
      'img[alt="Shared media"], img[alt="Sticker"], video, audio[controls]';

    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const chatButtons = page.locator(".space-y-px > button");
    await expect(chatButtons.first()).toBeVisible({ timeout: 10_000 });

    const chatCount = await chatButtons.count();
    let mediaReady = false;

    for (let i = 0; i < chatCount && !mediaReady; i++) {
      await page.goto("/");
      await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
      await page.locator(".space-y-px > button").nth(i).click();

      try {
        await page.waitForSelector(anyMediaSelector, { timeout: 10_000 });
        mediaReady = true;
      } catch {
        // Try next chat
      }
    }

    expect(mediaReady).toBe(true);
  });

  test("photos load with actual image content (not broken)", async ({
    page,
  }) => {
    test.setTimeout(30_000);

    const chatWithPhoto = await findChatWith(page, 'img[alt="Shared media"]');
    expect(chatWithPhoto).toBeTruthy();

    // Validate every visible photo has actually loaded (not broken/black)
    const photos = page.locator('img[alt="Shared media"]');
    const photoCount = await photos.count();
    expect(photoCount).toBeGreaterThan(0);

    for (let i = 0; i < photoCount; i++) {
      const img = photos.nth(i);
      const result = await img.evaluate((el) => {
        const imgEl = el as HTMLImageElement;
        return {
          complete: imgEl.complete,
          naturalWidth: imgEl.naturalWidth,
          naturalHeight: imgEl.naturalHeight,
          src: imgEl.src,
        };
      });

      expect(result.complete).toBe(true);
      expect(result.naturalWidth).toBeGreaterThan(0);
      expect(result.naturalHeight).toBeGreaterThan(0);
    }
  });

  test("videos are playable (metadata loads)", async ({ page }) => {
    test.setTimeout(30_000);

    const chatWithVideo = await findChatWith(page, "video:not([autoplay])");
    if (!chatWithVideo) {
      test.skip(true, "No video media found in synced chats");
      return;
    }

    // Find videos (non-autoplay = Video/VideoNote, not Animation)
    const videos = page.locator("video:not([autoplay])");
    const first = videos.first();
    await expect(first).toBeVisible({ timeout: 10_000 });

    // Load metadata and verify the browser can decode it
    const state = await first.evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      if (v.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          v.addEventListener("loadedmetadata", () => resolve(), {
            once: true,
          });
          v.addEventListener(
            "error",
            () =>
              reject(
                new Error(`Video error: ${v.error?.message ?? "unknown"}`)
              ),
            { once: true }
          );
          v.load();
        });
      }
      return {
        readyState: v.readyState,
        duration: v.duration,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
      };
    });

    expect(state.readyState).toBeGreaterThanOrEqual(1);
    expect(state.videoWidth).toBeGreaterThan(0);
    expect(state.videoHeight).toBeGreaterThan(0);
  });

  test("audio/voice messages are playable (metadata loads)", async ({
    page,
  }) => {
    test.setTimeout(30_000);

    const chatWithAudio = await findChatWith(page, "audio[controls]");
    if (!chatWithAudio) {
      test.skip(true, "No audio media found in synced chats");
      return;
    }

    const audios = page.locator("audio[controls]");
    const first = audios.first();
    await expect(first).toBeVisible({ timeout: 10_000 });

    const state = await first.evaluate(async (el) => {
      const a = el as HTMLAudioElement;
      if (a.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          a.addEventListener("loadedmetadata", () => resolve(), {
            once: true,
          });
          a.addEventListener(
            "error",
            () =>
              reject(
                new Error(`Audio error: ${a.error?.message ?? "unknown"}`)
              ),
            { once: true }
          );
          a.load();
        });
      }
      return {
        readyState: a.readyState,
        duration: a.duration,
      };
    });

    expect(state.readyState).toBeGreaterThanOrEqual(1);
    expect(state.duration).toBeGreaterThan(0);
  });

  test("documents show filename with extension", async ({ page }) => {
    test.setTimeout(30_000);

    // Document renderer is a <button> containing a filename with an extension
    const chatWithDoc = await findChatWith(
      page,
      'button:has(p:text-matches("\\\\.[a-z0-9]+$", "i"))'
    );
    if (!chatWithDoc) {
      test.skip(true, "No document media found in synced chats");
      return;
    }

    // Match filenames like "report.pdf", "image.png", etc.
    const docName = page.locator(
      'button p:text-matches("\\\\.[a-z0-9]+$", "i")'
    );
    await expect(docName.first()).toBeVisible({ timeout: 10_000 });

    const fileName = await docName.first().textContent();
    expect(fileName).toBeTruthy();
    // Filename must have an extension
    expect(fileName).toMatch(FILE_EXTENSION_RE);
  });

  test("stickers load as images with content", async ({ page }) => {
    test.setTimeout(30_000);

    const chatWithSticker = await findChatWith(page, 'img[alt="Sticker"]');
    if (!chatWithSticker) {
      test.skip(true, "No sticker media found in synced chats");
      return;
    }

    const stickers = page.locator('img[alt="Sticker"]');
    const first = stickers.first();
    await expect(first).toBeVisible({ timeout: 10_000 });

    const result = await first.evaluate((el) => {
      const imgEl = el as HTMLImageElement;
      return {
        complete: imgEl.complete,
        naturalWidth: imgEl.naturalWidth,
        naturalHeight: imgEl.naturalHeight,
      };
    });

    expect(result.complete).toBe(true);
    expect(result.naturalWidth).toBeGreaterThan(0);
    expect(result.naturalHeight).toBeGreaterThan(0);
  });

  test("animations autoplay as looping video", async ({ page }) => {
    test.setTimeout(30_000);

    const chatWithAnim = await findChatWith(page, "video[autoplay][loop]");
    if (!chatWithAnim) {
      test.skip(true, "No animation media found in synced chats");
      return;
    }

    const anim = page.locator("video[autoplay][loop]").first();
    await expect(anim).toBeVisible({ timeout: 10_000 });

    // Verify it has a source with video MIME type
    const source = anim.locator("source");
    const type = await source.getAttribute("type");
    expect(type).toMatch(VIDEO_MIME_RE);

    // Verify the video can load
    const state = await anim.evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      if (v.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          v.addEventListener("loadedmetadata", () => resolve(), {
            once: true,
          });
          v.addEventListener(
            "error",
            () =>
              reject(
                new Error(`Animation error: ${v.error?.message ?? "unknown"}`)
              ),
            { once: true }
          );
          v.load();
        });
      }
      return {
        readyState: v.readyState,
        videoWidth: v.videoWidth,
      };
    });

    expect(state.readyState).toBeGreaterThanOrEqual(1);
    expect(state.videoWidth).toBeGreaterThan(0);
  });

  test("photo lightbox opens fullscreen on click", async ({ page }) => {
    test.setTimeout(30_000);

    const chatWithPhoto = await findChatWith(page, 'img[alt="Shared media"]');
    if (!chatWithPhoto) {
      test.skip(true, "No photo found for lightbox test");
      return;
    }

    const img = page.locator('img[alt="Shared media"]').first();
    await expect(img).toBeVisible({ timeout: 10_000 });
    await img.click();

    // Dialog should open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Lightbox image should be present and loaded
    const lightboxImg = dialog.locator("img");
    await expect(lightboxImg).toBeVisible();

    const loaded = await lightboxImg.evaluate((el) => {
      const i = el as HTMLImageElement;
      return i.complete && i.naturalWidth > 0;
    });
    expect(loaded).toBe(true);

    // Close
    const closeButton = dialog.locator("button").first();
    await closeButton.click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Search all synced chats for a specific media selector.
 *
 * Returns true if found (page is left on that chat), false if no chat has it.
 * The setup test guarantees media is already downloaded, so this uses moderate
 * timeouts — just enough for Convex queries to settle + scroll loading.
 */
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

    // Wait for media to appear in the initial view
    try {
      await page.waitForSelector(selector, { timeout: 10_000 });
      return true;
    } catch {
      // Not in initial view — try scrolling up for older messages
    }

    // Scroll to top to trigger infinite scroll loading of older messages
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
