import { test as setup } from "@playwright/test";
import { staticEnv } from "./env";

const AUTH_FILE = "tests/.auth/user.json";
const CHATS_URL_PATTERN = /\/#\/chats/;

setup("authenticate", async ({ page }) => {
  await page.goto("/");

  // Two flows: if VITE_TEST_USERNAME is baked into the build, AutoSignIn
  // handles login automatically. Otherwise, fill the Clerk form manually.
  const clerkForm = page.locator('input[name="identifier"]');
  const autoSignInSpinner = page.locator("text=/Signing in as/");

  const which = await Promise.race([
    clerkForm.waitFor({ timeout: 15_000 }).then(() => "clerk" as const),
    autoSignInSpinner.waitFor({ timeout: 15_000 }).then(() => "auto" as const),
    page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 }).then(() => "done" as const),
  ]);

  if (which === "clerk") {
    await page.fill('input[name="identifier"]', staticEnv.TEST_CLERK_USERNAME);
    await page.click("button.cl-formButtonPrimary");
    await page.waitForSelector('input[name="password"]', { timeout: 10_000 });
    await page.fill('input[name="password"]', staticEnv.TEST_CLERK_PASSWORD);
    await page.click("button.cl-formButtonPrimary");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
  } else if (which === "auto") {
    // AutoSignIn is handling it — just wait for redirect
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 30_000 });
  }
  // else "done" — already redirected

  await page.waitForTimeout(3000);
  await page.context().storageState({ path: AUTH_FILE });
});
