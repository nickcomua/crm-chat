import crypto from "node:crypto";
import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { getDynamicEnv, staticEnv } from "./env";

const CHATS_URL_PATTERN = /\/#\/chats/;

/**
 * Mint an RS256 JWT for robot authentication against the test Convex backend.
 */
export function mintRobotJwt(): string {
  const { E2E_ROBOT_PRIVATE_KEY } = getDynamicEnv();

  const header = { alg: "RS256", kid: "e2e-robot-key", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "e2e-robot",
    iss: "https://crm-chat-robot.local",
    aud: "convex",
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(E2E_ROBOT_PRIVATE_KEY, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Create a ConvexHttpClient authenticated as the robot service.
 */
export function getRobotClient(): ConvexHttpClient {
  const { E2E_CONVEX_URL } = getDynamicEnv();

  const client = new ConvexHttpClient(E2E_CONVEX_URL);
  client.setAuth(mintRobotJwt());
  return client;
}

// Re-export anyApi for use in tests (avoids path alias issues)
export const api = anyApi;

const CLERK_ISSUER_DOMAIN = "https://noted-rabbit-14.clerk.accounts.dev";

/**
 * Extract the Convex tokenIdentifier (userId) from the browser after Clerk login.
 *
 * The Clerk React SDK exposes `window.Clerk.user.id` after authentication.
 * Convex constructs tokenIdentifier as `{issuer_domain}|{clerk_user_id}`.
 */
export async function getConvexUserId(page: Page): Promise<string> {
  const clerkUserId = await page.evaluate(() => {
    const w = globalThis as unknown as Record<
      string,
      Record<string, Record<string, string>>
    >;
    return w.Clerk?.user?.id ?? null;
  });

  if (!clerkUserId) {
    throw new Error(
      "Could not extract Clerk user ID from browser. Is the user logged in?"
    );
  }

  return `${CLERK_ISSUER_DOMAIN}|${clerkUserId}`;
}

/**
 * Register a Connected client via the robot API and create test chat data.
 * Returns the client ID.
 */
export async function seedTestClient(
  userId: string,
  externalId: string
): Promise<string> {
  const client = getRobotClient();

  // Register the client as Connected
  const clientId = await client.mutation(api.clients.robotRegisterConnected, {
    userId,
    externalId,
    kind: "Telegram",
  });

  // Create some test chats
  await client.mutation(api.chats.upsert, {
    chatId: `${clientId}:chat-pinned-1`,
    userId,
    clientId,
    chatType: "Dialog",
    isPinned: true,
    pinnedName: "Alice",
    lastMessageTs: Date.now(),
  });

  await client.mutation(api.chats.upsert, {
    chatId: `${clientId}:chat-unpinned-1`,
    userId,
    clientId,
    chatType: "Group",
    isPinned: false,
    pinnedName: "Team Chat",
    lastMessageTs: Date.now() - 3_600_000,
  });

  await client.mutation(api.chats.upsert, {
    chatId: `${clientId}:chat-pinned-2`,
    userId,
    clientId,
    chatType: "Dialog",
    isPinned: true,
    pinnedName: "Bob",
    lastMessageTs: Date.now() - 7_200_000,
  });

  return clientId as string;
}

/**
 * Log in via Clerk and navigate to the app.
 * Shared setup for all E2E tests that need authenticated access.
 */
export async function clerkLogin(page: Page): Promise<void> {
  const { TEST_CLERK_USERNAME, TEST_CLERK_PASSWORD } = staticEnv;

  await page.goto("/");
  await page.waitForSelector('input[name="identifier"]', { timeout: 15_000 });
  await page.fill('input[name="identifier"]', TEST_CLERK_USERNAME);
  await page.click("button.cl-formButtonPrimary");
  await page.waitForSelector('input[name="password"]', { timeout: 10_000 });
  await page.fill('input[name="password"]', TEST_CLERK_PASSWORD);
  await page.click("button.cl-formButtonPrimary");
  await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
  await page.waitForTimeout(3000);
}
