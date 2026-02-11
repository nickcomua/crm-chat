import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { qrAuthDoc } from "./schema";
import {
  isQrAuthTerminal,
  requireAssignedRobot,
  requireHuman,
  requireOwner,
  requireRobot,
  sendError,
} from "./helpers/auth";

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

/** Unclaimed QR auths (step=Pending, no assigned robot). For robot polling. */
export const pendingForRobot = query({
  args: {},
  returns: v.array(qrAuthDoc),
  handler: async (ctx) => {
    await requireRobot(ctx);
    const pending = await ctx.db
      .query("qrAuths")
      .withIndex("by_step", (q) => q.eq("step", "Pending"))
      .collect();
    return pending.filter((a) => !a.assignedRobot);
  },
});

/** QR auths assigned to the calling robot. */
export const assignedToRobot = query({
  args: {},
  returns: v.array(qrAuthDoc),
  handler: async (ctx) => {
    const caller = await requireRobot(ctx);
    const assigned = await ctx.db
      .query("qrAuths")
      .withIndex("by_assignedRobot", (q) => q.eq("assignedRobot", caller.id))
      .collect();
    return assigned.filter((a) => !isQrAuthTerminal(a.step));
  },
});

// =============================================================================
// Human Mutations
// =============================================================================

/** Start QR code authentication. No client is created yet. */
export const start = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    await ctx.db.insert("qrAuths", {
      userId: caller.id,
      step: "Pending",
      updatedAt: Date.now(),
    });
  },
});

/** User cancels the QR auth flow. */
export const cancel = mutation({
  args: { authId: v.id("qrAuths") },
  returns: v.null(),
  handler: async (ctx, { authId }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("QrAuth not found");
    requireOwner(caller.id, auth.userId);

    if (isQrAuthTerminal(auth.step)) {
      throw new Error("Cannot cancel: auth is already in a terminal state");
    }

    await ctx.db.patch(authId, {
      step: "Cancelled",
      updatedAt: Date.now(),
    });
  },
});

// =============================================================================
// Robot Mutations
// =============================================================================

/** Robot claims a QR auth session. */
export const robotClaim = mutation({
  args: { authId: v.id("qrAuths") },
  returns: v.null(),
  handler: async (ctx, { authId }) => {
    const caller = await requireRobot(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("QrAuth not found");

    if (auth.step !== "Pending") {
      throw new Error(`Invalid step: expected Pending, got ${auth.step}`);
    }
    if (auth.assignedRobot) {
      throw new Error("QrAuth is already claimed by a robot");
    }

    await ctx.db.patch(authId, {
      assignedRobot: caller.id,
      step: "Generating",
      updatedAt: Date.now(),
    });
  },
});

/** Robot provides a new QR token for the user to scan. */
export const robotUpdateQrToken = mutation({
  args: {
    authId: v.id("qrAuths"),
    url: v.string(),
    expires: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { authId, url, expires }) => {
    const caller = await requireRobot(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("QrAuth not found");
    requireAssignedRobot(caller.id, auth.assignedRobot);

    if (isQrAuthTerminal(auth.step)) {
      throw new Error("Cannot update: auth is in a terminal state");
    }

    await ctx.db.patch(authId, {
      qrUrl: url,
      qrExpires: expires,
      step: "Token",
      updatedAt: Date.now(),
    });
  },
});

/** Robot reports the final result of QR authentication. */
export const robotCompleteQrAuth = mutation({
  args: {
    authId: v.id("qrAuths"),
    result: v.union(
      v.object({ type: v.literal("Authorized"), userId: v.int64() }),
      v.object({ type: v.literal("AlreadyAuthorized"), userId: v.int64() }),
      v.object({ type: v.literal("Failed"), error: v.string() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { authId, result }) => {
    const caller = await requireRobot(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("QrAuth not found");
    requireAssignedRobot(caller.id, auth.assignedRobot);

    if (isQrAuthTerminal(auth.step)) {
      throw new Error("Cannot complete: auth is already in a terminal state");
    }

    const now = Date.now();

    if (result.type === "Authorized" || result.type === "AlreadyAuthorized") {
      const externalId = result.userId.toString();
      const step = result.type;

      // Find or create the client
      const existing = await ctx.db
        .query("clients")
        .withIndex("by_userId_externalId", (q) =>
          q.eq("userId", auth.userId).eq("externalId", externalId),
        )
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          status: { type: "Connected" },
        });
      } else {
        await ctx.db.insert("clients", {
          userId: auth.userId,
          kind: "Telegram",
          externalId,
          activeChats: [],
          status: { type: "Connected" },
        });
      }

      await ctx.db.patch(authId, {
        telegramUserId: result.userId,
        step,
        updatedAt: now,
      });
    } else {
      // Failed
      await sendError(ctx, auth.userId, `QR code login failed: ${result.error}`);
      await ctx.db.patch(authId, {
        step: "Failed",
        error: result.error,
        updatedAt: now,
      });
    }
  },
});
