import { expect, test } from "./fixtures";
import {
  getConvexUserId,
  getRobotClient,
  type Id,
  seedTestClient,
  type WorkerConfig,
} from "./helpers";

/**
 * Navigation Tests — UI Only
 *
 * Tests routing, header nav links, deep links, auth guard redirect,
 * and theme toggle persistence.
 */

const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/#\/settings/;
const DOWNLOADS_URL_PATTERN = /\/#\/downloads/;
const CHAT_DETAIL_URL_PATTERN = /\/#\/chats\//;
const CLIENT_URL_PATTERN = /\/#\/client\//;
const TEXT_PRIMARY_RE = /text-primary/;
const TEXT_MUTED_RE = /text-muted-foreground/;
const DARK_CLASS_RE = /dark/;
// Matches Clerk's network endpoints (clerk.accounts.dev, api.clerk.com,
// clerk-frontend-api), but NOT local/vite URLs that happen to include the
// word "clerk" in their path (e.g. /@fs/.../node_modules/@clerk/clerk-react/...).
// Using the broader /clerk/ regex would block the Clerk SDK bundle in dev mode
// so the app would never render.
const CLERK_API_RE = /\bclerk\.(accounts\.dev|com)\b/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let workerCfg: WorkerConfig;

test.describe("Navigation", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const robot = await getRobotClient(workerCfg);
    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    userId = await getConvexUserId(page);
    clientId = await seedTestClient(
      userId,
      `telegram:nav-test-${Date.now()}`,
      robot
    );

    await context.close();
  });

  test("root URL redirects to /chats", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
    expect(page.url()).toMatch(CHATS_URL_PATTERN);
  });

  test("header shows CRM Chat title", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Verified: _auth.tsx:97 — <h1>CRM Chat</h1>
    await expect(page.locator("h1:has-text('CRM Chat')")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("nav links: Chats, Downloads, Settings are visible", async ({
    page,
  }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Verified: _auth.tsx:101-137 — <nav> with <Link> children; text in <span class="hidden sm:inline">
    await expect(page.locator("nav a:has-text('Chats')")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("nav a:has-text('Downloads')")).toBeVisible();
    await expect(page.locator("nav a:has-text('Settings')")).toBeVisible();
  });

  test("Chats nav link navigates to /chats", async ({ page }) => {
    await page.goto("/#/settings");
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

    await page.locator("nav a:has-text('Chats')").click();
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
  });

  test("Downloads nav link navigates to /downloads", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    await page.locator("nav a:has-text('Downloads')").click();
    await page.waitForURL(DOWNLOADS_URL_PATTERN, { timeout: 10_000 });
  });

  test("Settings nav link navigates to /settings", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    await page.locator("nav a:has-text('Settings')").click();
    await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });
  });

  test("active nav link is highlighted", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    // Verified: _auth.tsx:106 — active link gets "bg-primary/10 text-primary"
    const chatsLink = page.locator("nav a:has-text('Chats')");
    await expect(chatsLink).toHaveClass(TEXT_PRIMARY_RE, { timeout: 10_000 });

    // Downloads link should NOT have primary color
    const downloadsLink = page.locator("nav a:has-text('Downloads')");
    await expect(downloadsLink).toHaveClass(TEXT_MUTED_RE);
  });

  test("deep link to chat works", async ({ page }) => {
    const chatId = `${clientId}:chat-pinned-1`;

    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);
    await page.waitForURL(CHAT_DETAIL_URL_PATTERN, { timeout: 10_000 });

    // The chat view should render (messages area or loading state)
    await expect(
      page.locator(".messages-bg").or(page.locator("text=Loading"))
    ).toBeVisible({ timeout: 10_000 });
  });

  test("deep link to client settings works", async ({ page }) => {
    await page.goto(`/#/client/${clientId}`);
    await page.waitForURL(CLIENT_URL_PATTERN, { timeout: 10_000 });

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

    // Verified: _auth.tsx:58 — <span className="sr-only">Toggle theme</span>
    const themeButton = page.locator('button:has(span:text("Toggle theme"))');
    await expect(themeButton).toBeVisible({ timeout: 10_000 });

    // Get current theme state
    const htmlBefore = await page.locator("html").getAttribute("class");
    const isDarkBefore = htmlBefore?.includes("dark");

    // Toggle theme and verify with auto-retrying matcher
    await themeButton.click();
    if (isDarkBefore) {
      await expect(page.locator("html")).not.toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    } else {
      await expect(page.locator("html")).toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    }

    // Toggle back
    await themeButton.click();
    if (isDarkBefore) {
      await expect(page.locator("html")).toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    } else {
      await expect(page.locator("html")).not.toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    }
  });

  test("theme persists across page reload", async ({ page }) => {
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

    const themeButton = page.locator('button:has(span:text("Toggle theme"))');
    await expect(themeButton).toBeVisible({ timeout: 10_000 });

    // Get current theme
    const htmlBefore = await page.locator("html").getAttribute("class");
    const isDarkBefore = htmlBefore?.includes("dark");

    // Toggle to opposite and wait for class change
    await themeButton.click();
    if (isDarkBefore) {
      await expect(page.locator("html")).not.toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    } else {
      await expect(page.locator("html")).toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    }

    // Reload the page
    await page.reload();
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });

    // Theme should persist after reload
    if (isDarkBefore) {
      await expect(page.locator("html")).not.toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    } else {
      await expect(page.locator("html")).toHaveClass(DARK_CLASS_RE, {
        timeout: 5000,
      });
    }

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
    await context.route(CLERK_API_RE, (route) => route.abort());

    // Disable AutoSignIn for this test. VITE_TEST_USERNAME is baked into the
    // build (needed so auth.setup can log in), so without this flag the /sign-in
    // route would render AutoSignIn and show "Signing in as tester..." instead
    // of the expected "Loading..." / "Sign in" UI.
    await context.addInitScript(() => {
      window.sessionStorage.setItem("e2e:disable-auto-signin", "1");
    });

    const page = await context.newPage();
    await page.goto("/#/chats");

    // With Clerk blocked, useAuth() resolves isSignedIn=false → redirects to /sign-in,
    // OR isLoaded stays false → shows "Loading..." spinner.
    // Either way, the protected nav should NOT be visible.
    await expect(
      page.locator("text=sign in").or(page.locator("text=Loading"))
    ).toBeVisible({ timeout: 15_000 });

    // Verified: createHashHistory() in main.tsx generates href="/#/chats" for <Link to="/chats">
    await expect(page.locator('a[href="/#/chats"]')).toBeHidden();

    await page.close();
  });
});
