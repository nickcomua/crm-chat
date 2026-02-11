import { test as setup } from "@playwright/test";
import { staticEnv } from "./env";

const AUTH_FILE = "tests/.auth/user.json";
const CHATS_URL_PATTERN = /\/#\/chats/;

setup("authenticate", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('input[name="identifier"]', { timeout: 15_000 });
  await page.fill('input[name="identifier"]', staticEnv.TEST_CLERK_USERNAME);
  await page.click("button.cl-formButtonPrimary");
  await page.waitForSelector('input[name="password"]', { timeout: 10_000 });
  await page.fill('input[name="password"]', staticEnv.TEST_CLERK_PASSWORD);
  await page.click("button.cl-formButtonPrimary");
  await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
  await page.waitForTimeout(3000);
  await page.context().storageState({ path: AUTH_FILE });
});
