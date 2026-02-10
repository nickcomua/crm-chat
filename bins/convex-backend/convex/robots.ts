import { mutation } from "./_generated/server";
import { requireRobot } from "./helpers/auth";

/** Register or update a robot on connect. */
export const register = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await requireRobot(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("robots")
      .withIndex("by_robotId", (q) => q.eq("robotId", caller.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        online: true,
        lastHeartbeat: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("robots", {
        robotId: caller.id,
        online: true,
        lastHeartbeat: now,
        updatedAt: now,
      });
    }
  },
});

/** Robot heartbeat. */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await requireRobot(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("robots")
      .withIndex("by_robotId", (q) => q.eq("robotId", caller.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastHeartbeat: now,
      });
    }
  },
});

/** Robot unregister. */
export const unregister = mutation({
  args: {},
  handler: async (ctx) => {
    const caller = await requireRobot(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("robots")
      .withIndex("by_robotId", (q) => q.eq("robotId", caller.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        online: false,
        updatedAt: now,
      });
    }
  },
});
