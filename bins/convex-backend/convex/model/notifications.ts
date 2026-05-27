import { defineTable } from "convex/server";
import { v } from "convex/values";
import { humanMutation, humanQuery } from "../functions";
import { err, ok, result } from "../helpers/result";

// =============================================================================
// Table-specific validators
// =============================================================================

export const messageSeverity = v.union(
	v.literal("Info"),
	v.literal("Warning"),
	v.literal("Error"),
);

const notificationFields = v.object({
	userId: v.string(),
	severity: messageSeverity,
	message: v.string(),
	dismissed: v.boolean(),
});

export const notificationDoc = notificationFields.extend({
	_id: v.id("notifications"),
	_creationTime: v.number(),
});

export const notificationsTable = defineTable(notificationFields)
	.index("by_userId", ["userId"])
	.index("by_userId_dismissed", ["userId", "dismissed"]);

/** List undismissed notifications for the current user. */
export const list = humanQuery({
	args: {},
	returns: v.array(notificationDoc),
	handler: async (ctx) => {
		return await ctx.db
			.query("notifications")
			.withIndex("by_userId_dismissed", (q) =>
				q.eq("userId", ctx.caller.tokenIdentifier).eq("dismissed", false),
			)
			.collect();
	},
});

/** Dismiss a notification. Only the owner can dismiss. */
export const dismiss = humanMutation({
	args: { notificationId: v.id("notifications") },
	returns: result(
		v.null(),
		v.union(
			v.literal("Notification not found"),
			v.literal("Notification is already dismissed"),
		),
	),
	handler: async (ctx, { notificationId }) => {
		const notif = await ctx.db.get(notificationId);
		if (!notif) {
			return err("Notification not found");
		}
		if (notif.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		if (notif.dismissed) {
			return err("Notification is already dismissed");
		}

		await ctx.db.patch(notificationId, { dismissed: true });
		return ok(null);
	},
});
