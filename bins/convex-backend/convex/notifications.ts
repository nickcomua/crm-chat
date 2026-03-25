import { v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireHuman, requireOwner } from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { notificationDoc } from "./schema";

/** List undismissed notifications for the current user. */
export const list = query({
  args: {},
  returns: v.array(notificationDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    return await ctx.db
      .query("notifications")
      .withIndex("by_userId_dismissed", (q) =>
        q.eq("userId", caller.id).eq("dismissed", false)
      )
      .collect();
  },
});

/** Dismiss a notification. Only the owner can dismiss. */
export const dismiss = mutation({
  args: { notificationId: v.id("notifications") },
  returns: result(
    v.null(),
    v.union(
      v.literal("Notification not found"),
      v.literal("Notification is already dismissed")
    )
  ),
  handler: async (ctx, { notificationId }) => {
    const caller = await requireHuman(ctx);
    const notif = await ctx.db.get(notificationId);
    if (!notif) {
      return err("Notification not found");
    }
    requireOwner(caller.id, notif.userId);

    if (notif.dismissed) {
      return err("Notification is already dismissed");
    }

    await ctx.db.patch(notificationId, { dismissed: true });
    return ok(null);
  },
});
