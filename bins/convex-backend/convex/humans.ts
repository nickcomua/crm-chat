import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireHuman } from "./helpers/auth";

/** Register or update a human user on connect. */
export const register = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("humans")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .unique();

    if (existing) {
      if (existing.online) {
        throw new Error("Human already connected");
      }
      await ctx.db.patch(existing._id, {
        online: true,
        lastHeartbeat: now,
        updatedAt: now,
        username: caller.email,
        displayName: caller.name,
      });
    } else {
      await ctx.db.insert("humans", {
        userId: caller.id,
        username: caller.email,
        displayName: caller.name,
        online: true,
        lastHeartbeat: now,
        updatedAt: now,
      });
    }
  },
});

/** Heartbeat to keep the human's online status alive. */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("humans")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastHeartbeat: now,
      });
    }
  },
});

/** Unregister a human on disconnect (best-effort, called on beforeunload). */
export const unregister = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("humans")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        online: false,
        updatedAt: now,
      });
    }
  },
});

/** Get the current human's profile. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    return await ctx.db
      .query("humans")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .unique();
  },
});
