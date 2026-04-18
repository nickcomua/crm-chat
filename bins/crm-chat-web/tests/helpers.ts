import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "crm-chat-convex-backend/convex/_generated/api";
import type { Id } from "crm-chat-convex-backend/convex/_generated/dataModel";
import { env } from "./env.ts";

/** Per-worker config passed via fixtures — avoids process.env race conditions. */
export interface WorkerConfig {
  convexUrl: string;
  // Undefined when the runner wasn't invoked via `secretspec run` (e.g. the
  // workspace-smoke project). Helpers that actually mint an M2M JWT must
  // assert it before use.
  m2mSecretKey: string | undefined;
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
 * Fetch an M2M JWT from the Clerk Backend API.
 */
async function fetchM2mJwt(m2mSecretKey: string): Promise<string> {
  const resp = await fetch("https://api.clerk.com/v1/m2m_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${m2mSecretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token_format: "jwt" }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Clerk M2M API returned ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as { token: string };
  return data.token;
}

/**
 * Create a ConvexHttpClient authenticated as the worker service via Clerk M2M.
 */
export async function getRobotClient(
  config: WorkerConfig
): Promise<ConvexHttpClient> {
  if (!config.m2mSecretKey) {
    throw new Error(
      "CLERK_M2M_SECRET_KEY must be set in the runner env (invoke via `secretspec run --profile e2e_web -- playwright test`) to use getRobotClient"
    );
  }
  const token = await fetchM2mJwt(config.m2mSecretKey);
  const client = new ConvexHttpClient(config.convexUrl);
  client.setAuth(token);
  return client;
}

/**
 * Create a ConvexHttpClient authenticated as the current browser user via
 * their Clerk session JWT. Use this when you need to call a `humanMutation`
 * from test-side code (not from the page itself). Requires the page to
 * already be signed in (i.e. auth.setup.ts must have run and the test's
 * browser context uses `storageState: "tests/.auth/user.json"`).
 */
export async function getHumanClient(
  page: Page,
  config: WorkerConfig
): Promise<ConvexHttpClient> {
  // Wait for Clerk SDK to expose a live session. `isSignedIn` becoming true
  // precedes `session` being attached by a tick or two on first navigation,
  // so poll rather than read once. Using a manual loop instead of
  // waitForFunction because the callback there must return synchronously.
  const deadline = Date.now() + 10_000;
  let token: string | null = null;
  while (Date.now() < deadline) {
    token = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        Clerk?: {
          loaded?: boolean;
          session?: { getToken: () => Promise<string | null> };
        };
      };
      if (!w.Clerk?.loaded || !w.Clerk.session) {
        return null;
      }
      return (await w.Clerk.session.getToken()) ?? null;
    });
    if (token) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!token) {
    throw new Error(
      "getHumanClient: window.Clerk.session never produced a token within 10s — page not signed in?"
    );
  }
  const client = new ConvexHttpClient(config.convexUrl);
  client.setAuth(token);
  return client;
}

export { api } from "crm-chat-convex-backend/convex/_generated/api";
export type { Id } from "crm-chat-convex-backend/convex/_generated/dataModel";

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

  return `${env.CLERK_JWT_ISSUER_DOMAIN}|${id}`;
}

/**
 * Register a Connected client via the robot API and create test chat data.
 * Returns the client ID.
 * Pass a `robot` client to avoid process.env race conditions across workers.
 */
export async function seedTestClient(
  userId: string,
  telegramId: string,
  robot: ConvexHttpClient
): Promise<Id<"clients">> {
  const client = robot;

  const clientId = (await client.mutation(
    api.model.clients.workerRegisterConnected,
    {
      userId,
      telegramId,
      kind: "Telegram",
    }
  )) as Id<"clients">;

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
  robot: ConvexHttpClient
): Promise<string> {
  const client = robot;
  return (await client.mutation(api.testHelpers.seedNotification, {
    userId,
    severity,
    message,
  })) as string;
}

/** Seed a media record at any status. Returns the media ID. */
export async function seedMediaRecord(
  userId: string,
  clientId: Id<"clients">,
  chatId: string,
  messageId: string,
  kind: MediaKind,
  status: MediaStatus,
  robot: ConvexHttpClient,
  opts?: {
    telegramFileId?: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    error?: string;
    downloadedAt?: number;
  }
): Promise<string> {
  const client = robot;
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
  clientId: Id<"clients">,
  chatId: string,
  messageId: string,
  text: string | undefined,
  robot: ConvexHttpClient,
  opts?: {
    externalId?: string;
    senderId?: string;
    outgoing?: boolean;
    deleted?: boolean;
    timestamp?: number;
    replyToMessageId?: string;
    forwardedFrom?: { senderName: string; date?: number };
    reactions?: Array<{
      emoji: string;
      count: number;
      recent: Array<{ userId: string }>;
    }>;
  }
): Promise<void> {
  const client = robot;
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
    forwardedFrom: opts?.forwardedFrom,
    reactions: opts?.reactions,
  });
}

/** Delete all data for a user. Use for cleanup or empty-state tests. */
export async function cleanupUser(
  userId: string,
  robot: ConvexHttpClient
): Promise<void> {
  const client = robot;
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
  mkdirSync(dir, { recursive: true });
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
 * Wait for pending ChatScanner work items to drain so the worker has capacity
 * for QrAuth. tg-scan tests enqueue scanners that may still be pending
 * when tg-qr-auth starts — if the worker is busy dispatching those,
 * QrAuth token generation can exceed the timeout.
 */
export async function waitForPendingScanners(
  robot: ConvexHttpClient,
  timeoutMs = 30_000
): Promise<void> {
  const client = robot;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const items = (await client.query(
      api.model.chats.pendingWork,
      {}
    )) as Array<{ service: string }>;

    if (items.length === 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Don't throw — proceed anyway; the QR test has its own timeout.
}
