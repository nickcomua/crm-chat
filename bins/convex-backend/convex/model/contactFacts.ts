import { defineTable } from "convex/server";
import { v } from "convex/values";
import { humanMutation, humanQuery } from "../functions";
import { err, ok, result } from "../helpers/result";

const factKind = v.union(
	v.literal("note"),
	v.literal("knowledge"),
	v.literal("task"),
	v.literal("link"),
	v.literal("date"),
);

const factPriority = v.union(
	v.literal("low"),
	v.literal("normal"),
	v.literal("high"),
	v.literal("critical"),
);

const factSource = v.union(
	v.object({ type: v.literal("manual") }),
	v.object({ type: v.literal("message"), messageId: v.string() }),
	v.object({ type: v.literal("status"), senderId: v.string() }),
);

const contactFactFields = v.object({
	userId: v.string(),
	contactId: v.id("contacts"),
	kind: factKind,
	title: v.string(),
	body: v.optional(v.string()),
	priority: factPriority,
	pinned: v.boolean(),
	source: factSource,
	occurredAt: v.number(),
	dueAt: v.optional(v.number()),
	createdAt: v.number(),
	updatedAt: v.number(),
});

export const contactFactDoc = contactFactFields.extend({
	_id: v.id("contactFacts"),
	_creationTime: v.number(),
});

export const contactFactsTable = defineTable(contactFactFields)
	.index("by_contactId_occurredAt", ["contactId", "occurredAt"])
	.index("by_contactId_priority", ["contactId", "priority"])
	.index("by_contactId_pinned", ["contactId", "pinned"])
	.index("by_userId", ["userId"]);

const factInput = v.object({
	kind: factKind,
	title: v.string(),
	body: v.optional(v.string()),
	priority: factPriority,
	pinned: v.boolean(),
	occurredAt: v.optional(v.number()),
	dueAt: v.optional(v.number()),
});

export const listForContact = humanQuery({
	args: { contactId: v.id("contacts") },
	returns: v.array(contactFactDoc),
	handler: async (ctx, { contactId }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return [];
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		return await ctx.db
			.query("contactFacts")
			.withIndex("by_contactId_occurredAt", (q) => q.eq("contactId", contactId))
			.order("desc")
			.collect();
	},
});

export const create = humanMutation({
	args: { contactId: v.id("contacts"), fact: factInput },
	returns: result(v.id("contactFacts"), v.literal("Contact not found")),
	handler: async (ctx, { contactId, fact }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return err("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		const title = fact.title.trim();
		const body = fact.body?.trim();
		const now = Date.now();
		const factId = await ctx.db.insert("contactFacts", {
			userId: ctx.caller.tokenIdentifier,
			contactId,
			kind: fact.kind,
			title,
			body: body && body.length > 0 ? body : undefined,
			priority: fact.priority,
			pinned: fact.pinned,
			source: { type: "manual" },
			occurredAt: fact.occurredAt ?? now,
			dueAt: fact.dueAt,
			createdAt: now,
			updatedAt: now,
		});
		return ok(factId);
	},
});

export const update = humanMutation({
	args: {
		factId: v.id("contactFacts"),
		fact: v.object({
			kind: v.optional(factKind),
			title: v.optional(v.string()),
			body: v.optional(v.string()),
			priority: v.optional(factPriority),
			pinned: v.optional(v.boolean()),
			occurredAt: v.optional(v.number()),
			dueAt: v.optional(v.number()),
		}),
	},
	returns: result(v.null(), v.literal("Fact not found")),
	handler: async (ctx, { factId, fact }) => {
		const existing = await ctx.db.get(factId);
		if (!existing) {
			return err("Fact not found");
		}
		if (existing.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		await ctx.db.patch(factId, {
			...fact,
			title: fact.title?.trim(),
			body: fact.body?.trim(),
			updatedAt: Date.now(),
		});
		return ok(null);
	},
});

export const remove = humanMutation({
	args: { factId: v.id("contactFacts") },
	returns: result(v.null(), v.literal("Fact not found")),
	handler: async (ctx, { factId }) => {
		const existing = await ctx.db.get(factId);
		if (!existing) {
			return err("Fact not found");
		}
		if (existing.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		await ctx.db.delete(factId);
		return ok(null);
	},
});
