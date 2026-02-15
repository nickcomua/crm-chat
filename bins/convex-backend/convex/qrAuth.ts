import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { qrAuthDoc } from "./schema";
import {
  isQrAuthTerminal,
  requireAssignedWorker,
  requireHuman,
  requireOwner,
  requireWorker,
  sendError,
} from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueClientStart, enqueueTask } from "./helpers/tasks";

// =============================================================================
// Queries
// =============================================================================

/** Active QR auths + most recent terminal auth for the current user. */
export const listForUser = query({
  args: {},
  returns: v.array(qrAuthDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const all = await ctx.db
      .query("qrAuths")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .collect();
    const activeAuths = all.filter((a) => !isQrAuthTerminal(a.step));
    const mostRecentTerminal = all
      .filter((a) => isQrAuthTerminal(a.step))
      .sort((a, b) => b._creationTime - a._creationTime)[0];
    return mostRecentTerminal ? [...activeAuths, mostRecentTerminal] : activeAuths;
  },
});

/** Active (non-terminal) QR auths for the current human user. */
export const active = query({
  args: {},
  returns: v.array(qrAuthDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const all = await ctx.db
      .query("qrAuths")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .collect();
    return all.filter((a) => !isQrAuthTerminal(a.step));
  },
});

// =============================================================================
// Human Mutations
// =============================================================================

/** Start QR code authentication. No client is created yet. */
export const start = mutation({
  args: {},
  returns: result(v.null()),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const authId = await ctx.db.insert("qrAuths", {
      userId: caller.id,
      step: "Pending",
      updatedAt: Date.now(),
    });

    // Enqueue worker task
    const auth = await ctx.db.get(authId);
    if (auth) {
      await enqueueTask(ctx, { type: "QrAuth:run", authId, doc: JSON.stringify(auth) });
    }

    return ok(null);
  },
});

/** User cancels the QR auth flow. */
export const cancel = mutation({
  args: { authId: v.id("qrAuths") },
  returns: result(v.null()),
  handler: async (ctx, { authId }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("QrAuth not found");
    requireOwner(caller.id, auth.userId);

    if (isQrAuthTerminal(auth.step)) {
      return err("Cannot cancel: auth is already in a terminal state");
    }

    await ctx.db.patch(authId, {
      step: "Cancelled",
      updatedAt: Date.now(),
    });

    // Enqueue worker task
    await enqueueTask(ctx, { type: "QrAuth:cancel", authId });

    return ok(null);
  },
});

// =============================================================================
// Worker Mutations
// =============================================================================

/** Worker claims a QR auth session. */
export const workerClaim = mutation({
  args: { authId: v.id("qrAuths") },
  returns: result(v.null()),
  handler: async (ctx, { authId }) => {
    const caller = await requireWorker(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("QrAuth not found");

    if (auth.step !== "Pending") {
      return err(`Invalid step: expected Pending, got ${auth.step}`);
    }
    if (auth.claimedByWorkerId) {
      return err("QrAuth is already claimed by a worker");
    }

    await ctx.db.patch(authId, {
      claimedByWorkerId: caller.id,
      step: "Generating",
      updatedAt: Date.now(),
    });
    return ok(null);
  },
});

/** Worker provides a new QR token for the user to scan. */
export const workerUpdateQrToken = mutation({
  args: {
    authId: v.id("qrAuths"),
    url: v.string(),
    expires: v.number(),
  },
  returns: result(v.null()),
  handler: async (ctx, { authId, url, expires }) => {
    const caller = await requireWorker(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("QrAuth not found");
    requireAssignedWorker(caller.id, auth.claimedByWorkerId);

    if (isQrAuthTerminal(auth.step)) {
      return err("Cannot update: auth is in a terminal state");
    }

    await ctx.db.patch(authId, {
      qrUrl: url,
      qrExpires: expires,
      step: "Token",
      updatedAt: Date.now(),
    });
    return ok(null);
  },
});

/** Worker reports the final result of QR authentication. */
export const workerCompleteQrAuth = mutation({
  args: {
    authId: v.id("qrAuths"),
    result: v.union(
      v.object({ type: v.literal("Authorized"), userId: v.int64() }),
      v.object({ type: v.literal("AlreadyAuthorized"), userId: v.int64() }),
      v.object({ type: v.literal("Failed"), error: v.string() }),
    ),
  },
  returns: result(v.null()),
  handler: async (ctx, { authId, result: qrResult }) => {
    const caller = await requireWorker(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("QrAuth not found");
    requireAssignedWorker(caller.id, auth.claimedByWorkerId);

    if (isQrAuthTerminal(auth.step)) {
      return err("Cannot complete: auth is already in a terminal state");
    }

    const now = Date.now();

    if (qrResult.type === "Authorized" || qrResult.type === "AlreadyAuthorized") {
      const telegramId = `telegram:${qrResult.userId}`;
      const step = qrResult.type;

      // Find or create the client
      const existing = await ctx.db
        .query("clients")
        .withIndex("by_userId_telegramId", (q) =>
          q.eq("userId", auth.userId).eq("telegramId", telegramId),
        )
        .unique();

      let clientId;
      if (existing) {
        await ctx.db.patch(existing._id, {
          status: { type: "Connected" },
        });
        clientId = existing._id;
      } else {
        clientId = await ctx.db.insert("clients", {
          userId: auth.userId,
          kind: "Telegram",
          telegramId,
          scanningChatIds: [],
          status: { type: "Connected" },
        });
      }

      await ctx.db.patch(authId, {
        telegramUserId: qrResult.userId,
        step,
        updatedAt: now,
      });

      // Enqueue client services
      const client = await ctx.db.get(clientId);
      if (client) await enqueueClientStart(ctx, client);
    } else {
      // Failed
      await sendError(ctx, auth.userId, `QR code login failed: ${qrResult.error}`);
      await ctx.db.patch(authId, {
        step: "Failed",
        error: qrResult.error,
        updatedAt: now,
      });
    }
    return ok(null);
  },
});
