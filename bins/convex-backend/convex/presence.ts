/**
 * Presence — wrappers around @convex-dev/presence component.
 *
 * These mutations match the API shape expected by `usePresence` from
 * `@convex-dev/presence/react`, so the frontend can use the library hook
 * directly (heartbeat, visibility-change, sendBeacon disconnect, etc.).
 *
 * **How offline cleanup works:**
 *
 * 1. Each heartbeat upserts `humans.online = true` and schedules a delayed
 *    `setOffline` mutation at 2.5× the heartbeat interval.
 * 2. The next heartbeat cancels the previous scheduled `setOffline` and
 *    reschedules a new one. As long as heartbeats keep coming, `setOffline`
 *    never fires.
 * 3. When heartbeats stop (tab close, crash, network drop), the scheduled
 *    `setOffline` fires and patches `humans.online = false`.
 * 4. A trigger registered on the `humans` table in `functions.ts` detects
 *    the `online: true → false` transition and cancels all active QR auth
 *    tasks for that user.
 *
 * Graceful close (beforeunload sendBeacon) also calls `disconnect`, which
 * immediately sets `humans.online = false` and fires the same trigger.
 */

import { Presence } from "@convex-dev/presence";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { requireHuman } from "./helpers/auth";

const presence = new Presence(components.presence);

/** Returns the authenticated user's tokenIdentifier for the React hook. */
export const getUserId = query({
	args: {},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		return identity?.tokenIdentifier ?? null;
	},
});

/**
 * Heartbeat — called by the library hook every `interval` ms.
 *
 * 1. Auth-validates the caller (ignores client-sent userId).
 * 2. Upserts `humans.online = true`.
 * 3. Cancels any existing offline timeout and schedules a new one at 2.5×
 *    the heartbeat interval.
 * 4. Delegates to the presence component for session tracking.
 */
export const heartbeat = mutation({
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
		const caller = await requireHuman(ctx);

		// Upsert humans row — mark online
		const existing = await ctx.db
			.query("humans")
			.withIndex("by_userId", (q) => q.eq("userId", caller.id))
			.unique();

		// Cancel previous timeout
		if (existing?.timeoutId) {
			await ctx.scheduler.cancel(existing.timeoutId);
		}

		// Schedule new timeout at 2.5× interval
		const timeoutId = await ctx.scheduler.runAfter(
			interval * 2.5,
			internal.presence.setOffline,
			{ userId: caller.id },
		);

		if (existing) {
			await ctx.db.patch(existing._id, { online: true, timeoutId });
		} else {
			await ctx.db.insert("humans", {
				userId: caller.id,
				online: true,
				timeoutId,
			});
		}

		return await presence.heartbeat(
			ctx,
			roomId,
			caller.id,
			sessionId,
			interval,
		);
	},
});

/**
 * Disconnect — called via sendBeacon on beforeunload (no auth).
 *
 * Delegates to the presence component, then checks if the disconnecting
 * user has any remaining online sessions. If not, marks them offline
 * in the `humans` table (which fires the cleanup trigger).
 *
 * Note: We can't auth-check here (sendBeacon doesn't send auth headers),
 * so we use `presence.listRoom` to find who just went offline.
 */
export const disconnect = mutation({
	args: { sessionToken: v.string() },
	handler: async (ctx, { sessionToken }) => {
		await presence.disconnect(ctx, sessionToken);

		// After disconnect, check all online humans — mark any that are now
		// fully offline (no remaining sessions in the "global" room).
		const humans = await ctx.db
			.query("humans")
			.withIndex("by_userId")
			.collect();
		for (const human of humans) {
			if (!human.online) continue;
			const rooms = await presence.listUser(ctx, human.userId, true);
			if (rooms.length === 0) {
				// Cancel pending timeout since we're setting offline now
				if (human.timeoutId) {
					await ctx.scheduler.cancel(human.timeoutId);
				}
				await ctx.db.patch(human._id, {
					online: false,
					timeoutId: undefined,
				});
			}
		}
	},
});

/**
 * Set a user offline after their heartbeat times out.
 *
 * Scheduled by `heartbeat` at 2.5× the heartbeat interval. Each heartbeat
 * cancels the previous schedule — this only fires when heartbeats actually
 * stop. Patching `online: false` fires the trigger in `functions.ts`.
 */
export const setOffline = internalMutation({
	args: { userId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId }) => {
		const human = await ctx.db
			.query("humans")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.unique();
		if (human?.online) {
			await ctx.db.patch(human._id, {
				online: false,
				timeoutId: undefined,
			});
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
