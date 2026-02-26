import crypto from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { getDynamicEnv, staticEnv } from "./env";

const CHATS_URL_PATTERN = /\/#\/chats/;

/**
 * Unwrap a Convex `result()` return value.
 * Convex mutations using the `result()` helper return `{ok: true, value: T}` or `{ok: false, error: string}`.
 */
export function unwrapResult<T>(res: unknown): T {
  const r = res as { ok: boolean; value?: T; error?: string };
  if (!r.ok) {
    throw new Error(`Mutation failed: ${r.error}`);
  }
  return r.value as T;
}

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
  telegramId: string
): Promise<string> {
  const client = getRobotClient();

  // Register the client as Connected (returns bare v.id, not result-wrapped)
  const clientId = (await client.mutation(api.clients.workerRegisterConnected, {
    userId,
    telegramId,
    kind: "Telegram",
  })) as string;

  // Create some test chats
  await client.mutation(api.testHelpers.seedChat, {
    chatId: `${clientId}:chat-pinned-1`,
    userId,
    clientId,
    chatType: "Dialog",
    isPinned: true,
    pinnedName: "Alice",
    lastMessageTimestamp: Date.now(),
  });

  await client.mutation(api.testHelpers.seedChat, {
    chatId: `${clientId}:chat-unpinned-1`,
    userId,
    clientId,
    chatType: "Group",
    isPinned: false,
    pinnedName: "Team Chat",
    lastMessageTimestamp: Date.now() - 3_600_000,
  });

  await client.mutation(api.testHelpers.seedChat, {
    chatId: `${clientId}:chat-pinned-2`,
    userId,
    clientId,
    chatType: "Dialog",
    isPinned: true,
    pinnedName: "Bob",
    lastMessageTimestamp: Date.now() - 7_200_000,
  });

  return clientId;
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

// =============================================================================
// Test data seeding helpers (use robot client → convex/testHelpers.ts mutations)
// =============================================================================

type Severity = "Info" | "Warning" | "Error";
type MediaKind =
  | "Photo"
  | "Video"
  | "VideoNote"
  | "Audio"
  | "Voice"
  | "Sticker"
  | "Animation"
  | "Document";
type MediaStatus = "Pending" | "Downloading" | "Stored" | "Failed" | "Skipped";

/** Seed a notification for a user. Returns the notification ID. */
export async function seedNotification(
  userId: string,
  severity: Severity,
  message: string
): Promise<string> {
  const robot = getRobotClient();
  return (await robot.mutation(api.testHelpers.seedNotification, {
    userId,
    severity,
    message,
  })) as string;
}

/** Seed a media record at any status. Returns the media ID. */
export async function seedMediaRecord(
  userId: string,
  clientId: string,
  chatId: string,
  messageId: string,
  kind: MediaKind,
  status: MediaStatus,
  opts?: {
    telegramFileId?: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    error?: string;
    downloadedAt?: number;
  }
): Promise<string> {
  const robot = getRobotClient();
  return (await robot.mutation(api.testHelpers.seedMediaRecord, {
    telegramFileId:
      opts?.telegramFileId ?? `test-file-${Date.now()}-${Math.random()}`,
    userId,
    clientId,
    chatId,
    messageId,
    kind,
    status,
    mimeType: opts?.mimeType,
    fileName: opts?.fileName,
    fileSize: opts?.fileSize,
    error: opts?.error,
    downloadedAt: opts?.downloadedAt,
  })) as string;
}

/** Seed a message with optional reply/forward/reaction fields. */
export async function seedMessage(
  userId: string,
  clientId: string,
  chatId: string,
  messageId: string,
  text: string | undefined,
  opts?: {
    externalId?: string;
    senderId?: string;
    outgoing?: boolean;
    deleted?: boolean;
    timestamp?: number;
    replyToMessageId?: string;
    replyToText?: string;
    forwardedFrom?: { senderName: string; date?: number };
    reactions?: Array<{
      emoji: string;
      count: number;
      recent: Array<{ userId: string }>;
    }>;
  }
): Promise<void> {
  const robot = getRobotClient();
  await robot.mutation(api.testHelpers.seedMessage, {
    messageId,
    externalId: opts?.externalId ?? `ext-${messageId}`,
    userId,
    clientId,
    chatId,
    senderId: opts?.senderId ?? "sender-test",
    text,
    outgoing: opts?.outgoing ?? false,
    deleted: opts?.deleted ?? false,
    timestamp: opts?.timestamp ?? Date.now(),
    replyToMessageId: opts?.replyToMessageId,
    replyToText: opts?.replyToText,
    forwardedFrom: opts?.forwardedFrom,
    reactions: opts?.reactions,
  });
}

/** Delete all data for a user. Use for cleanup or empty-state tests. */
export async function cleanupUser(userId: string): Promise<void> {
  const robot = getRobotClient();
  await robot.mutation(api.testHelpers.deleteAllForUser, { userId });
}

/** Mirror Rust's sanitize_owner_id: replace non-alphanumeric (except - _) with _ */
export function sanitizeOwnerId(ownerId: string): string {
  return ownerId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Mirror Rust's sanitize for session paths: keep only digits and + */
export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^0-9+]/g, "");
}

/** Compute session file path using E2E_SESSION_DIR. */
export function getSessionPath(
  identifier: string,
  ownerId: string
): string {
  const baseDir = process.env.E2E_SESSION_DIR;
  if (!baseDir) {
    throw new Error("E2E_SESSION_DIR not set — is globalSetup running?");
  }
  const dir = path.join(baseDir, sanitizeOwnerId(ownerId));
  return path.join(dir, `${sanitizeIdentifier(identifier)}.session`);
}

/**
 * Poll a condition with configurable interval.
 * Individual checks are instant; overall bounded by test.setTimeout.
 */
export async function pollUntil(
  page: Page,
  condition: () => Promise<boolean>,
  intervalMs = 5000
): Promise<void> {
  while (!(await condition())) {
    await page.waitForTimeout(intervalMs);
  }
}
