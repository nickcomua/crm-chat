import crypto from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { getDynamicEnv } from "./env";

/** Per-worker config passed via fixtures — avoids process.env race conditions. */
export interface WorkerConfig {
  convexUrl: string;
  robotPrivateKey: string;
  sessionDir: string;
}

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
 * Accepts optional config to avoid reading process.env (which races across workers).
 */
export function mintRobotJwt(config?: WorkerConfig): string {
  const privateKey = config
    ? config.robotPrivateKey
    : getDynamicEnv().E2E_ROBOT_PRIVATE_KEY;

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
  const signature = sign.sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Create a ConvexHttpClient authenticated as the robot service.
 * Accepts optional config to avoid reading process.env (which races across workers).
 */
export function getRobotClient(config?: WorkerConfig): ConvexHttpClient {
  const convexUrl = config ? config.convexUrl : getDynamicEnv().E2E_CONVEX_URL;

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(mintRobotJwt(config));
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
  // Wait for Clerk SDK to initialize (loads async from CDN)
  const clerkUserId = await page.waitForFunction(
    () => {
      const w = globalThis as unknown as Record<
        string,
        Record<string, Record<string, string>>
      >;
      return w.Clerk?.user?.id ?? null;
    },
    { timeout: 10_000 }
  );

  const id = await clerkUserId.jsonValue();
  if (!id) {
    throw new Error(
      "Could not extract Clerk user ID from browser. Is the user logged in?"
    );
  }

  return `${CLERK_ISSUER_DOMAIN}|${id}`;
}

/**
 * Register a Connected client via the robot API and create test chat data.
 * Returns the client ID.
 * Pass a `robot` client to avoid process.env race conditions across workers.
 */
export async function seedTestClient(
  userId: string,
  telegramId: string,
  robot?: ConvexHttpClient
): Promise<string> {
  const client = robot ?? getRobotClient();

  // Register the client as Connected (returns bare v.id, not result-wrapped).
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
  message: string,
  robot?: ConvexHttpClient
): Promise<string> {
  const client = robot ?? getRobotClient();
  return (await client.mutation(api.testHelpers.seedNotification, {
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
  },
  robot?: ConvexHttpClient
): Promise<string> {
  const client = robot ?? getRobotClient();
  return (await client.mutation(api.testHelpers.seedMediaRecord, {
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
  },
  robot?: ConvexHttpClient
): Promise<void> {
  const client = robot ?? getRobotClient();
  await client.mutation(api.testHelpers.seedMessage, {
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
export async function cleanupUser(
  userId: string,
  robot?: ConvexHttpClient
): Promise<void> {
  const client = robot ?? getRobotClient();
  await client.mutation(api.testHelpers.deleteAllForUser, { userId });
}

/** Mirror Rust's sanitize_owner_id: replace non-alphanumeric (except - _) with _ */
export function sanitizeOwnerId(ownerId: string): string {
  return ownerId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const TELEGRAM_PREFIX_RE = /^telegram:/;

/**
 * Compute session file path matching Rust session_manager's naming convention.
 *
 * Rust (session_manager.rs get_for_telegram_id):
 *   suffix = telegram_id.strip_prefix("telegram:").unwrap_or(telegram_id)
 *   stem = format!("telegram_{suffix}")
 *   path = owner_dir / "{stem}.session"
 *
 * Example: identifier="telegram:+84779004206", ownerId="https://…|user123"
 *   → {E2E_SESSION_DIR}/{sanitized_owner}/telegram_+84779004206.session
 */
export function getSessionPath(
  identifier: string,
  ownerId: string,
  sessionDir?: string
): string {
  const baseDir = sessionDir ?? process.env.E2E_SESSION_DIR;
  if (!baseDir) {
    throw new Error("E2E_SESSION_DIR not set — is globalSetup running?");
  }
  const dir = path.join(baseDir, sanitizeOwnerId(ownerId));
  // Strip "telegram:" scheme prefix, then use "telegram_" file prefix (matching Rust)
  const suffix = identifier.replace(TELEGRAM_PREFIX_RE, "");
  return path.join(dir, `telegram_${suffix}.session`);
}

/**
 * Write .owner file in the session directory.
 * Matches Rust session_manager's owner_dir() which writes the raw ownerId
 * so discover_sessions() can map subdirectories back to Convex user IDs.
 */
export function writeOwnerFile(sessionPath: string, ownerId: string): void {
  const dir = path.dirname(sessionPath);
  const ownerFile = path.join(dir, ".owner");
  if (!existsSync(ownerFile)) {
    writeFileSync(ownerFile, ownerId);
  }
}

/**
 * Poll a condition with configurable interval and timeout.
 * Throws with a descriptive message if the condition is not met within maxTimeMs.
 */
export async function pollUntil(
  _page: Page,
  condition: () => Promise<boolean>,
  intervalMs = 5000,
  maxTimeMs = 30_000
): Promise<void> {
  const deadline = Date.now() + maxTimeMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(
        `pollUntil timed out after ${maxTimeMs}ms (interval: ${intervalMs}ms)`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Wait for pending ChatScanner tasks to drain so the worker has capacity
 * for QrAuth. tg-scan tests enqueue scanners that may still be pending
 * when tg-qr-auth starts — if the worker is busy dispatching those,
 * QrAuth token generation can exceed the timeout.
 */
export async function waitForPendingScanners(
  timeoutMs = 30_000,
  robot?: ConvexHttpClient
): Promise<void> {
  const client = robot ?? getRobotClient();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tasks = (await client.query(api.workerTasks.pendingForWorker, {
      maxMediaWorkflows: 0,
    })) as Array<{ task: { type: string } }>;

    const scanners = tasks.filter((t) => t.task.type === "ChatScanner");
    if (scanners.length === 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Don't throw — proceed anyway; the QR test has its own timeout.
}
