import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { test as setup } from "./fixtures";

const AUTH_FILE = "tests/.auth/user.json";
const USER_META_FILE = "tests/.auth/user-meta.json";
const CHATS_URL_PATTERN = /\/#\/chats/;

setup("authenticate", async ({ page }) => {
  await page.goto("/");

  // AutoSignIn component handles login automatically when VITE_TEST_USERNAME
  // is baked into the build. Just wait for the redirect to complete.
  await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });

  // Wait for Clerk SDK to fully initialize before saving storage state
  const clerkUserHandle = await page.waitForFunction(
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

  // Cache the Convex tokenIdentifier so individual test describes can skip
  // the expensive "open browser + goto / + waitForURL(/chats)" dance just to
  // look up `userId`. Under load (cold crm-worker compile, convex dev
  // startup) that dance has exceeded the 15s waitForURL budget and flaked.
  const clerkUserId = (await clerkUserHandle.jsonValue()) as string;
  const userMeta = {
    clerkUserId,
    tokenIdentifier: `${env.CLERK_JWT_ISSUER_DOMAIN}|${clerkUserId}`,
  };
  await fs.mkdir(path.dirname(USER_META_FILE), { recursive: true });
  await fs.writeFile(USER_META_FILE, JSON.stringify(userMeta, null, 2));
});
