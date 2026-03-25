import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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

const CHATS_URL_PATTERN = /\/#\/chats/;
const FILE_EXTENSION_RE = /\.[a-z0-9]+$/i;
const VIDEO_MIME_RE = /^video\//;
const DOWNLOADS_URL_PATTERN = /\/#\/downloads/;

// Run tests sequentially — they depend on subscriber sync completing first
test.describe.configure({ mode: "serial" });

let registeredClientId: Id<"clients">;
let copiedSessionPath: string;
let workerCfg: WorkerConfig;

test.describe("Media Rendering — Real Telegram Data", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;

    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const convexUserId = await getConvexUserId(page);

    // Share telegramId with scan-chats — one Telegram connection for all real-TG specs
    const telegramId = `telegram:${env.TG_USER_ID_1}`;
    copiedSessionPath = getSessionPath(
      telegramId,
      convexUserId,
      workerCfg.sessionDir
    );
    mkdirSync(path.dirname(copiedSessionPath), { recursive: true });
    if (!existsSync(copiedSessionPath)) {
      copyFileSync(env.TG_SESSION_FILE_1, copiedSessionPath);
    }
    writeOwnerFile(copiedSessionPath, convexUserId);

    const robot = await getRobotClient(workerCfg);
    registeredClientId = (await robot.mutation(
      api.clients.workerRegisterConnected,
      {
        userId: convexUserId,
        telegramId,
        kind: "Telegram",
      }
    )) as Id<"clients">;

    await page.close();
  });

  test("enable scanning and wait for sync + media download", async ({
    page,
  }) => {
    // Real TG sync: DialogSync completes in ~2s, scanning may take a bit longer

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

    // Poll for "Synced" badge — 1s interval (page is Convex-reactive)
    await pollUntil(
      page,
      () => page.locator("text=Synced").first().isVisible(),
      1000
    );

    // Poll Downloads page until at least one media is stored.
    // This confirms the full pipeline completed: scan → enqueue → download → upload.
    await page.goto("/#/downloads");
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });
    await pollUntil(
      page,
      () => {
        const recentSection = page.locator('text="Recent"');
        return recentSection.isVisible();
      },
      1000
    );

    // Now find media in a chat — downloads are confirmed done.
    // The message list may take a moment to re-render with media URLs,
    // so poll the chat iteration rather than doing a single pass.
    const anyMediaSelector =
      'img[alt="Shared media"], img[alt="Sticker"], video, audio[controls]';

    await pollUntil(
      page,
      async () => {
        await page.goto("/");
        await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

        // Only click real Telegram chats (skip seeded data from parallel specs)
        const buttons = page.locator(
          '.space-y-px > button:has-text("telegram:")'
        );
        const fallbackButtons = page.locator(".space-y-px > button");
        await expect(fallbackButtons.first()).toBeVisible({ timeout: 10_000 });

        const chatCount = await buttons.count();
        for (let i = 0; i < chatCount; i++) {
          await buttons.nth(i).click();
          try {
            await page.waitForSelector(anyMediaSelector, { timeout: 3000 });
            return true;
          } catch {
            // No media in this chat, try next
          }
        }
        return false;
      },
      5000
    );
  });

  test("photos load with actual image content (not broken)", async ({
    page,
  }) => {
    const chatWithPhoto = await findChatWith(page, 'img[alt="Shared media"]');
    expect(chatWithPhoto, "No photo media found in test data").toBeTruthy();

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
    const chatWithVideo = await findChatWith(page, "video:not([autoplay])");
    expect(chatWithVideo, "No video media found in test data").toBeTruthy();

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
    const chatWithAudio = await findChatWith(page, "audio[controls]");
    expect(chatWithAudio, "No audio media found in test data").toBeTruthy();

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
    // Document renderer is a <button> containing a filename with an extension
    const chatWithDoc = await findChatWith(
      page,
      'button:has(p:text-matches("\\\\.[a-z0-9]+$", "i"))'
    );
    expect(chatWithDoc, "No document media found in test data").toBeTruthy();

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
    const chatWithSticker = await findChatWith(page, 'img[alt="Sticker"]');
    expect(chatWithSticker, "No sticker media found in test data").toBeTruthy();

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
    const chatWithAnim = await findChatWith(page, "video[autoplay][loop]");
    expect(chatWithAnim, "No animation media found in test data").toBeTruthy();

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
    const chatWithPhoto = await findChatWith(page, 'img[alt="Shared media"]');
    expect(chatWithPhoto, "No photo media found in test data").toBeTruthy();

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
  // Navigate once; sidebar stays visible in desktop SPA layout.
  await page.goto("/");
  await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

  // Only click real Telegram chats (skip seeded test data from parallel specs).
  // Real TG chats display "telegram:..." badge in the sidebar.
  const buttons = page.locator('.space-y-px > button:has-text("telegram:")');
  const fallbackButtons = page.locator(".space-y-px > button");
  await expect(fallbackButtons.first()).toBeVisible({ timeout: 10_000 });

  const count = await buttons.count();

  for (let i = 0; i < count; i++) {
    await buttons.nth(i).click();

    // Check initial view (media already downloaded, 3s is enough)
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      return true;
    } catch {
      // Not in initial view — try scrolling up for older messages
    }

    // Scroll to top to trigger infinite scroll loading of older messages
    const msgContainer = page.locator(".messages-bg");
    if ((await msgContainer.count()) > 0) {
      await msgContainer.evaluate((el) => el.scrollTo(0, 0));
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        return true;
      } catch {
        // Not found, try next chat
      }
    }
  }

  return false;
}
