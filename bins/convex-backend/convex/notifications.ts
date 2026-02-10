import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { messageSeverity } from "./schema";
import { requireHuman, requireOwner } from "./helpers/auth";

/** List undismissed notifications for the current user. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    return await ctx.db
      .query("notifications")
      .withIndex("by_userId_dismissed", (q) =>
        q.eq("userId", caller.id).eq("dismissed", false),
      )
      .collect();
  },
});

/** Dismiss a notification. Only the owner can dismiss. */
export const dismiss = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const caller = await requireHuman(ctx);
    const notif = await ctx.db.get(notificationId);
    if (!notif) {
      throw new Error("Notification not found");
    }
    requireOwner(caller.id, notif.userId);

    if (notif.dismissed) {
      throw new Error("Notification is already dismissed");
    }

    await ctx.db.patch(notificationId, { dismissed: true });
  },
});

/**
 * Internal helper: send a notification. Callable from other mutations.
 * This is an internalMutation so it can be called from phoneAuth/qrAuth
 * mutations within the same transaction.
 */
export const sendNotification = internalMutation({
  args: {
    userId: v.string(),
    severity: messageSeverity,
    message: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notifications", {
      userId: args.userId,
      severity: args.severity,
      message: args.message,
      dismissed: false,
    });
  },
});
