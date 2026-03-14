import { test as setup } from "./fixtures";

const AUTH_FILE = "tests/.auth/user.json";
const CHATS_URL_PATTERN = /\/#\/chats/;

setup("authenticate", async ({ page }) => {
  await page.goto("/");

  // AutoSignIn component handles login automatically when VITE_TEST_USERNAME
  // is baked into the build. Just wait for the redirect to complete.
  await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });

  // Wait for Clerk SDK to fully initialize before saving storage state
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as Record<
        string,
        Record<string, Record<string, string>>
      >;
      return w.Clerk?.user?.id ?? null;
    },
    { timeout: 10_000 }
  );
  await page.context().storageState({ path: AUTH_FILE });
});
