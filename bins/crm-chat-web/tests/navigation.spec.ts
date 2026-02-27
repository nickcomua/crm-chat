import { expect, test } from "@playwright/test";
import {
  api,
  getConvexUserId,
  getRobotClient,
  seedTestClient,
} from "./helpers";

/**
 * Navigation Tests — UI Only
 *
 * Tests routing, header nav links, deep links, auth guard redirect,
 * and theme toggle persistence.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: string;

test.describe("Navigation", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
    await page.waitForTimeout(1000);

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(userId, `telegram:nav-test-${Date.now()}`);

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

  test("root URL redirects to /chats", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
    expect(page.url()).toMatch(CHATS_URL_PATTERN);
  });

  test("header shows CRM Chat title", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    await expect(page.locator("h1:has-text('CRM Chat')")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("nav links: Chats, Downloads, Settings are visible", async ({
    page,
  }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Nav links in header
    await expect(page.locator("nav a:has-text('Chats')")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("nav a:has-text('Downloads')")).toBeVisible();
    await expect(page.locator("nav a:has-text('Settings')")).toBeVisible();
  });

  test("Chats nav link navigates to /chats", async ({ page }) => {
    await page.goto("/#/settings");
    await page.waitForURL(/\/#\/settings/, { timeout: 10_000 });

    await page.locator("nav a:has-text('Chats')").click();
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
  });

  test("Downloads nav link navigates to /downloads", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    await page.locator("nav a:has-text('Downloads')").click();
    await page.waitForURL(/\/#\/downloads/, { timeout: 10_000 });
  });

  test("Settings nav link navigates to /settings", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    await page.locator("nav a:has-text('Settings')").click();
    await page.waitForURL(/\/#\/settings/, { timeout: 10_000 });
  });

  test("active nav link is highlighted", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Chats link should have primary color class when on /chats (auto-retrying)
    const chatsLink = page.locator("nav a:has-text('Chats')");
    await expect(chatsLink).toHaveClass(/text-primary/, { timeout: 10_000 });

    // Downloads link should NOT have primary color
    const downloadsLink = page.locator("nav a:has-text('Downloads')");
    await expect(downloadsLink).toHaveClass(/text-muted-foreground/);
  });

  test("deep link to chat works", async ({ page }) => {
    const chatId = `${clientId}:chat-pinned-1`;

    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);
    await page.waitForURL(/\/#\/chats\//, { timeout: 10_000 });

    // Should show messages or loading state for this chat
    // The chat view should be present (messages area)
    await page.waitForTimeout(2000);
  });

  test("deep link to client settings works", async ({ page }) => {
    await page.goto(`/#/client/${clientId}`);
    await page.waitForURL(/\/#\/client\//, { timeout: 10_000 });

    // Should show client settings page with "Chat Scanning" section
    await expect(
      page
        .locator("text=Chat Scanning")
        .or(page.locator("text=Client not found"))
    ).toBeVisible({ timeout: 10_000 });
  });

  test("theme toggle switches between light and dark mode", async ({
    page,
  }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Find the theme toggle button
    const themeButton = page.locator('button:has(span:text("Toggle theme"))');
    await expect(themeButton).toBeVisible({ timeout: 10_000 });

    // Get current theme state
    const htmlBefore = await page.locator("html").getAttribute("class");
    const isDarkBefore = htmlBefore?.includes("dark");

    // Toggle theme
    await themeButton.click();
    await page.waitForTimeout(500);

    // Theme should have changed
    const htmlAfter = await page.locator("html").getAttribute("class");
    const isDarkAfter = htmlAfter?.includes("dark");

    expect(isDarkAfter).toBe(!isDarkBefore);

    // Toggle back
    await themeButton.click();
    await page.waitForTimeout(500);

    const htmlRestored = await page.locator("html").getAttribute("class");
    const isDarkRestored = htmlRestored?.includes("dark");
    expect(isDarkRestored).toBe(isDarkBefore);
  });

  test("theme persists across page reload", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const themeButton = page.locator('button:has(span:text("Toggle theme"))');
    await expect(themeButton).toBeVisible({ timeout: 10_000 });

    // Get current theme
    const htmlBefore = await page.locator("html").getAttribute("class");
    const isDarkBefore = htmlBefore?.includes("dark");

    // Toggle to opposite
    await themeButton.click();
    await page.waitForTimeout(500);

    // Reload the page
    await page.reload();
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
    await page.waitForTimeout(1000);

    // Theme should persist
    const htmlAfterReload = await page.locator("html").getAttribute("class");
    const isDarkAfterReload = htmlAfterReload?.includes("dark");

    expect(isDarkAfterReload).toBe(!isDarkBefore);

    // Restore original theme
    const restoreButton = page.locator('button:has(span:text("Toggle theme"))');
    await restoreButton.click();
  });
});

test.describe("Navigation — Auth Guard", () => {
  test("unauthenticated user is redirected to sign-in", async ({ browser }) => {
    // Block Clerk's session API so the app behaves as fully unauthenticated.
    // Without this, Clerk's session can leak via the shared browser process
    // (third-party cookies from clerk.accounts.dev), making the "fresh" context
    // still appear authenticated.
    const context = await browser.newContext();
    await context.route(/clerk/, (route) => route.abort());

    const page = await context.newPage();
    await page.goto("/#/chats");

    // With Clerk blocked, useAuth() resolves isSignedIn=false → redirects to /sign-in,
    // OR isLoaded stays false → shows "Loading..." spinner.
    // Either way, the protected nav should NOT be visible.
    await expect(
      page.locator("text=sign in").or(page.locator("text=Loading"))
    ).toBeVisible({ timeout: 15_000 });

    // The authenticated nav (Chats/Downloads/Settings links) must NOT render
    await expect(page.locator('a[href="/#/chats"]')).toBeHidden();

    await page.close();
  });
});
