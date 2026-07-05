import { defineTable } from "convex/server";
import { v } from "convex/values";
import { humanQuery, workerMutation } from "../functions";

const presenceStatus = v.union(
	v.literal("online"),
	v.literal("offline"),
	v.literal("recently"),
	v.literal("lastWeek"),
	v.literal("lastMonth"),
	v.literal("empty"),
);

const contactPresenceFields = v.object({
	userId: v.string(),
	clientId: v.id("clients"),
	senderId: v.string(),
	status: presenceStatus,
	observedAt: v.number(),
	expiresAt: v.optional(v.number()),
	wasOnlineAt: v.optional(v.number()),
	raw: v.optional(v.string()),
});

export const contactPresenceDoc = contactPresenceFields.extend({
	_id: v.id("contactPresence"),
	_creationTime: v.number(),
});

export const contactPresenceTable = defineTable(contactPresenceFields)
	.index("by_userId_senderId_observedAt", ["userId", "senderId", "observedAt"])
	.index("by_clientId_senderId_observedAt", [
		"clientId",
		"senderId",
		"observedAt",
	])
	.index("by_userId_observedAt", ["userId", "observedAt"]);

export const workerRecordStatus = workerMutation({
	args: {
		userId: v.string(),
		clientId: v.id("clients"),
		senderId: v.string(),
		status: presenceStatus,
		observedAt: v.number(),
		expiresAt: v.optional(v.number()),
		wasOnlineAt: v.optional(v.number()),
		raw: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.insert("contactPresence", args);
		return null;
	},
});

export const listForContact = humanQuery({
	args: { contactId: v.id("contacts"), limit: v.optional(v.number()) },
	returns: v.array(contactPresenceDoc),
	handler: async (ctx, { contactId, limit }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return [];
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		const links = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_contactId", (q) => q.eq("contactId", contactId))
			.collect();
		const senderIds = [...new Set(links.map((link) => link.senderId))];
		const take = Math.min(limit ?? 300, 1000);
		const rows = [];
		for (const senderId of senderIds) {
			const senderRows = await ctx.db
				.query("contactPresence")
				.withIndex("by_userId_senderId_observedAt", (q) =>
					q.eq("userId", ctx.caller.tokenIdentifier).eq("senderId", senderId),
				)
				.order("desc")
				.take(take);
			rows.push(...senderRows);
		}
		return rows
			.sort((left, right) => right.observedAt - left.observedAt)
			.slice(0, take);
	},
});
