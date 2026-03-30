import { defineTable } from "convex/server";
import { v } from "convex/values";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  humanMutation,
  humanQuery,
  sendError,
  workerMutation,
  workerQuery,
} from "../functions";
import { err, ok, result } from "../helpers/result";
import { workItem } from "../helpers/validators";

// =============================================================================
// Table-specific validators
// =============================================================================

export const qrAuthStep = v.union(
  v.literal("Pending"),
  v.literal("Generating"),
  v.literal("Token"),
  v.literal("Authorized"),
  v.literal("AlreadyAuthorized"),
  v.literal("Failed"),
  v.literal("Cancelled")
);

const qrAuthFields = v.object({
  userId: v.string(),
  clientId: v.id("clients"),
  step: qrAuthStep,
  qrUrl: v.optional(v.string()),
  qrExpires: v.optional(v.number()),
  telegramUserId: v.optional(v.int64()),
  phoneNumber: v.optional(v.string()),
  error: v.optional(v.string()),
  updatedAt: v.number(),
});

export const qrAuthDoc = qrAuthFields.extend({
  _id: v.id("qrAuths"),
  _creationTime: v.number(),
});

/** qrAuthDoc without secrets -- safe for human-facing queries. */
export const qrAuthPublicDoc = v.object({
  _id: v.id("qrAuths"),
  _creationTime: v.number(),
  userId: v.string(),
  clientId: v.id("clients"),
  step: qrAuthStep,
  qrUrl: v.optional(v.string()),
  qrExpires: v.optional(v.number()),
  error: v.optional(v.string()),
  updatedAt: v.number(),
});

export const qrAuthsTable = defineTable(qrAuthFields)
  .index("by_userId", ["userId"])
  .index("by_step", ["step"])
  .index("by_clientId", ["clientId"]);

const QR_AUTH_TERMINAL = new Set([
  "Authorized",
  "AlreadyAuthorized",
  "Failed",
  "Cancelled",
]);

// =============================================================================
// Human Mutations
// =============================================================================

/** Start QR code authentication. Creates a qrAuth record and returns its ID. */
export const start = humanMutation({
  args: {},
  returns: v.id("qrAuths"),
  handler: async (ctx) => {
    // Create a client placeholder in Authenticating state (for UI tracking)
    const clientId = await ctx.db.insert("clients", {
      userId: ctx.caller.tokenIdentifier,
      kind: "Telegram",
      telegramId: `qr-pending:${Date.now()}`,
      scanningChatIds: [],
      status: { type: "Authenticating" },
      phase: "Authenticating",
    });

    const authId = await ctx.db.insert("qrAuths", {
      userId: ctx.caller.tokenIdentifier,
      clientId,
      step: "Pending" as const,
      updatedAt: Date.now(),
    });

    return authId;
  },
});

/** User cancels the QR auth flow. Worker detects via step subscription. */
export const cancel = humanMutation({
  args: { authId: v.id("qrAuths") },
  returns: result(
    v.null(),
    v.union(
      v.literal("Auth not found"),
      v.literal("Unauthorized"),
      v.literal("Cannot cancel: auth is already in a terminal state")
    )
  ),
  handler: async (ctx, { authId }) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return err("Auth not found");
    }
    if (auth.userId !== ctx.caller.tokenIdentifier) {
      return err("Unauthorized");
    }
    if (QR_AUTH_TERMINAL.has(auth.step)) {
      return err("Cannot cancel: auth is already in a terminal state");
    }

    await ctx.db.patch(authId, {
      step: "Cancelled" as const,
      updatedAt: Date.now(),
    });

    // Clean up placeholder client if auth was never completed
    const client = await ctx.db.get(auth.clientId);
    if (client && client.status.type === "Authenticating") {
      await ctx.db.delete(auth.clientId);
    }

    return ok(null);
  },
});

/** Get a qrAuth record for the current user (for frontend subscription). */
export const getForUser = humanQuery({
  args: { authId: v.id("qrAuths") },
  returns: v.union(qrAuthPublicDoc, v.null()),
  handler: async (ctx, { authId }) => {
    const auth = await ctx.db.get(authId);
    if (!auth || auth.userId !== ctx.caller.tokenIdentifier) {
      return null;
    }
    return {
      _id: auth._id,
      _creationTime: auth._creationTime,
      userId: auth.userId,
      clientId: auth.clientId,
      step: auth.step,
      qrUrl: auth.qrUrl,
      qrExpires: auth.qrExpires,
      error: auth.error,
      updatedAt: auth.updatedAt,
    };
  },
});

// =============================================================================
// Worker Mutations
// =============================================================================

/** Get the full qrAuth record for the worker. Worker-only. */
export const getForWorker = workerQuery({
  args: { authId: v.id("qrAuths") },
  returns: v.union(
    v.object({
      _id: v.id("qrAuths"),
      _creationTime: v.number(),
      userId: v.string(),
      clientId: v.id("clients"),
      step: qrAuthStep,
      qrUrl: v.optional(v.string()),
      qrExpires: v.optional(v.number()),
      telegramUserId: v.optional(v.int64()),
      phoneNumber: v.optional(v.string()),
      error: v.optional(v.string()),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, { authId }) => {
    return await ctx.db.get(authId);
  },
});

/** Worker updates the QR token URL. Worker-only. */
export const workerUpdateToken = workerMutation({
  args: {
    authId: v.id("qrAuths"),
    step: qrAuthStep,
    qrUrl: v.optional(v.string()),
    qrExpires: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { authId, step, qrUrl, qrExpires }) => {
    const auth = await ctx.db.get(authId);
    if (!auth || QR_AUTH_TERMINAL.has(auth.step)) {
      return null;
    }
    await ctx.db.patch(authId, {
      step,
      qrUrl,
      qrExpires,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Worker completes QR auth (success or failure). Worker-only.
 *  On success: creates/updates client with phase=NeedsSync.
 *  On failure: sends error notification. */
export const workerComplete = workerMutation({
  args: {
    authId: v.id("qrAuths"),
    step: qrAuthStep,
    telegramUserId: v.optional(v.int64()),
    phoneNumber: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { authId, step, telegramUserId, phoneNumber, error: errorMsg }
  ) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return null;
    }

    await ctx.db.patch(authId, {
      step,
      telegramUserId,
      phoneNumber,
      error: errorMsg,
      updatedAt: Date.now(),
    });

    await completeQrAuth(ctx, auth.userId, auth.clientId, {
      step,
      telegramUserId,
      phoneNumber,
      error: errorMsg,
    });

    return null;
  },
});

// =============================================================================
// Completion logic
// =============================================================================

interface QrAuthCompletion {
  error?: string;
  phoneNumber?: string;
  step: string;
  telegramUserId?: bigint;
}

/** Handle successful QR auth (Authorized / AlreadyAuthorized). */
async function completeQrAuthSuccess(
  ctx: MutationCtx,
  ownerUserId: string,
  placeholderClientId: Id<"clients">,
  telegramUserId: bigint,
  phoneNumber?: string
): Promise<void> {
  const numericId = telegramUserId.toString();
  let normalizedPhone: string | null = null;
  if (phoneNumber) {
    normalizedPhone = phoneNumber.startsWith("+")
      ? phoneNumber
      : `+${phoneNumber}`;
  }
  const telegramId = normalizedPhone
    ? `telegram:${normalizedPhone}`
    : `telegram:${numericId}`;

  const existing = await ctx.db
    .query("clients")
    .withIndex("by_userId_telegramId", (q) =>
      q.eq("userId", ownerUserId).eq("telegramId", telegramId)
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      status: { type: "Connected" },
      phase: "NeedsSync" as const,
      externalId: numericId,
      ...(normalizedPhone ? { phoneNumber: normalizedPhone } : {}),
    });
    if (placeholderClientId !== existing._id) {
      await ctx.db.delete(placeholderClientId);
    }
  } else {
    await ctx.db.patch(placeholderClientId, {
      telegramId,
      externalId: numericId,
      phoneNumber: normalizedPhone ?? undefined,
      status: { type: "Connected" },
      phase: "NeedsSync" as const,
    });
  }
}

/** Delete placeholder client if it's still in Authenticating state. */
async function cleanupPlaceholderClient(
  ctx: MutationCtx,
  placeholderClientId: Id<"clients">
): Promise<void> {
  const client = await ctx.db.get(placeholderClientId);
  if (client && client.status.type === "Authenticating") {
    await ctx.db.delete(placeholderClientId);
  }
}

async function completeQrAuth(
  ctx: MutationCtx,
  ownerUserId: string,
  placeholderClientId: Id<"clients">,
  completion: QrAuthCompletion
): Promise<void> {
  if (
    completion.step === "Authorized" ||
    completion.step === "AlreadyAuthorized"
  ) {
    if (!completion.telegramUserId) {
      throw new Error("QrAuth completion requires telegramUserId");
    }
    await completeQrAuthSuccess(
      ctx,
      ownerUserId,
      placeholderClientId,
      completion.telegramUserId,
      completion.phoneNumber
    );
  } else if (completion.step === "Failed") {
    await sendError(
      ctx,
      ownerUserId,
      `QR code login failed: ${completion.error ?? "unknown error"}`
    );
    await cleanupPlaceholderClient(ctx, placeholderClientId);
  } else if (completion.step === "Cancelled") {
    await cleanupPlaceholderClient(ctx, placeholderClientId);
  }
}

// =============================================================================
// Cancel-watcher query (for domain-driven dispatch)
// =============================================================================

/**
 * Lightweight step query for domain cancel-watcher.
 * Rust handler subscribes to this and cancels when step becomes terminal.
 */
export const getStep = workerQuery({
  args: { authId: v.id("qrAuths") },
  returns: v.union(qrAuthStep, v.null()),
  handler: async (ctx, { authId }) => {
    const auth = await ctx.db.get(authId);
    return auth?.step ?? null;
  },
});

// =============================================================================
// Pending work (for reconciler dispatch)
// =============================================================================

/** QR auth sessions that need a worker. */
export const pendingWork = workerQuery({
  args: {},
  returns: v.array(workItem),
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("qrAuths")
      .withIndex("by_step", (q) => q.eq("step", "Pending"))
      .collect();
    return pending.map((a) => ({
      service: "QrAuthWorkflow",
      key: a._id,
      handler: "run",
    }));
  },
});
