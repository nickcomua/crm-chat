/**
 * Presence — wrappers around @convex-dev/presence component.
 *
 * These mutations match the API shape expected by `usePresence` from
 * `@convex-dev/presence/react`, so the frontend can use the library hook
 * directly (heartbeat, visibility-change, sendBeacon disconnect, etc.).
 *
 * **How offline cleanup works:**
 *
 * 1. Each heartbeat calls `handleConnect` and schedules a delayed
 *    `checkOffline` at 2.5× the heartbeat interval.
 * 2. As long as heartbeats keep coming, new `checkOffline` calls are scheduled
 *    but each one is idempotent — it checks `presence.listUser` to verify the
 *    user is truly offline before running `handleDisconnect`.
 * 3. When heartbeats stop (tab close, crash, network drop), the scheduled
 *    `checkOffline` fires, sees no active sessions, and runs
 *    `handleDisconnect` to cancel active QR auth sessions.
 * 4. Graceful close (beforeunload sendBeacon) also calls `disconnect`, which
 *    immediately checks if the user has remaining sessions and runs
 *    `handleDisconnect`.
 *
 * The `onConnect`/`onDisconnect` internal mutations expose the same handlers
 * as entry points for external callers (actions, scheduled fns, other services).
 */

import { Presence } from "@convex-dev/presence";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { humanMutation, internalMutation, mutation } from "../functions";

const presence = new Presence(components.presence);

// =============================================================================
// Core connect / disconnect handlers
// =============================================================================

/**
 * Connect handler — called every heartbeat when a user is online.
 * Placeholder for future connect-time side effects.
 */
async function handleConnect(
  _ctx: MutationCtx,
  _userId: string
): Promise<void> {
  // No-op — hook for future logic (e.g. update last-seen, sync state, etc.)
}

/**
 * Disconnect handler — called when a user goes offline.
 * Cancels all active (non-terminal) QR auth sessions for that user.
 */
async function handleDisconnect(
  ctx: MutationCtx,
  userId: string
): Promise<void> {
  const qrAuths = await ctx.db
    .query("qrAuths")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();

  for (const auth of qrAuths) {
    if (
      auth.step === "Pending" ||
      auth.step === "Generating" ||
      auth.step === "Token"
    ) {
      await ctx.db.patch(auth._id, {
        step: "Cancelled",
        updatedAt: Date.now(),
      });
    }
  }
}


// =============================================================================
// Presence mutations — called by the frontend usePresence hook
// =============================================================================

/**
 * Heartbeat — called by the library hook every `interval` ms.
 *
 * 1. Auth-validates the caller (ignores client-sent userId).
 * 2. Runs `handleConnect` for connect-time side effects.
 * 3. Schedules a `checkOffline` at 2.5× the heartbeat interval.
 * 4. Delegates to the presence component for session tracking.
 */
export const heartbeat = humanMutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  returns: v.object({
    roomToken: v.string(),
    sessionToken: v.string(),
  }),
  handler: async (ctx, { roomId, sessionId, interval }) => {
    await handleConnect(ctx, ctx.caller.tokenIdentifier);

    // Schedule offline check — fires only if heartbeats stop
    await ctx.scheduler.runAfter(
      interval * 2.5,
      internal.model.presence.checkOffline,
      { userId: ctx.caller.tokenIdentifier }
    );

    return await presence.heartbeat(
      ctx,
      roomId,
      ctx.caller.tokenIdentifier,
      sessionId,
      interval
    );
  },
});

/**
 * Disconnect — called via sendBeacon on beforeunload (no auth).
 *
 * Delegates to the presence component, then checks if any users with
 * active QR auth sessions have gone fully offline and runs
 * `handleDisconnect` for each.
 *
 * Note: We can't auth-check here (sendBeacon doesn't send auth headers),
 * so we check presence for each user that has a non-terminal QR auth session.
 */
export const disconnect = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await presence.disconnect(ctx, sessionToken);

    // Find users with active QR auth sessions and disconnect if fully offline.
    // Very few users have active QR auths at any given time, so a full scan is cheap.
    const qrAuths = await ctx.db.query("qrAuths").collect();
    const usersToCheck = new Set<string>();

    for (const auth of qrAuths) {
      if (
        auth.step === "Pending" ||
        auth.step === "Generating" ||
        auth.step === "Token"
      ) {
        usersToCheck.add(auth.userId);
      }
    }

    for (const userId of usersToCheck) {
      const rooms = await presence.listUser(ctx, userId, true);
      if (rooms.length === 0) {
        await handleDisconnect(ctx, userId);
      }
    }
  },
});

/**
 * Check if a user went offline after their heartbeat timed out.
 *
 * Scheduled by `heartbeat` at 2.5× the heartbeat interval. If the user
 * still has active presence sessions, this is a no-op. Otherwise, runs
 * `handleDisconnect` to cancel active QR auth sessions.
 */
export const checkOffline = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const rooms = await presence.listUser(ctx, userId, true);
    if (rooms.length === 0) {
      await handleDisconnect(ctx, userId);
    }
    return null;
  },
});

/**
 * List presence state for a room. Used by the library hook to
 * reactively display who's online.
 */
export const list = query({
  args: { roomToken: v.string() },
  handler: async (ctx, { roomToken }) => {
    return await presence.list(ctx, roomToken);
  },
});
