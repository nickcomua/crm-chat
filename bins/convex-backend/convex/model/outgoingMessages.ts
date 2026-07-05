import { defineTable } from "convex/server";
import { type Infer, v } from "convex/values";
import { humanMutation, workerMutation, workerQuery } from "../functions";
import { err, ok, result } from "../helpers/result";

const outgoingMessageStatus = v.union(
	v.literal("Queued"),
	v.literal("Sending"),
	v.literal("Sent"),
	v.literal("Failed"),
);

const outgoingMessageFields = v.object({
	userId: v.string(),
	clientId: v.id("clients"),
	chatId: v.string(),
	text: v.string(),
	status: outgoingMessageStatus,
	attempts: v.number(),
	error: v.optional(v.string()),
	externalMessageId: v.optional(v.string()),
	createdAt: v.number(),
	updatedAt: v.number(),
	lastAttemptedAt: v.optional(v.number()),
});

export const outgoingMessageDoc = outgoingMessageFields.extend({
	_id: v.id("outgoingMessages"),
	_creationTime: v.number(),
});

export const outgoingMessagesTable = defineTable(outgoingMessageFields)
	.index("by_userId_status", ["userId", "status"])
	.index("by_status", ["status"])
	.index("by_clientId", ["clientId"])
	.index("by_userId", ["userId"]);

const pendingOutgoingMessageWorkItem = v.object({
	service: v.literal("SendMessage"),
	key: v.id("outgoingMessages"),
	handler: v.string(),
});

const sendingLeaseMs = 2 * 60 * 1000;

/** Queue message worker-driven Telegram send. */
export const send = humanMutation({
	args: {
		chatId: v.string(),
		text: v.string(),
	},
	returns: result(
		v.id("outgoingMessages"),
		v.union(
			v.literal("Chat not found"),
			v.literal("Message text is empty"),
			v.literal("Unauthorized: you do not own chat"),
		),
	),
	handler: async (ctx, { chatId, text }) => {
		const normalized = text.trim();
		if (!normalized) {
			return err("Message text is empty");
		}

		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat) {
			return err("Chat not found");
		}
		if (chat.userId !== ctx.caller.tokenIdentifier) {
			return err("Unauthorized: you do not own chat");
		}

		const now = Date.now();
		const outgoingMessageId = await ctx.db.insert("outgoingMessages", {
			userId: ctx.caller.tokenIdentifier,
			clientId: chat.clientId,
			chatId,
			text: normalized,
			status: "Queued",
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		});

		return ok(outgoingMessageId);
	},
});

export const pendingWork = workerQuery({
	args: {},
	returns: v.array(pendingOutgoingMessageWorkItem),
	handler: async (ctx) => {
		const queuedRows = await ctx.db
			.query("outgoingMessages")
			.withIndex("by_status", (q) => q.eq("status", "Queued"))
			.collect();
		const sendingRows = await ctx.db
			.query("outgoingMessages")
			.withIndex("by_status", (q) => q.eq("status", "Sending"))
			.collect();

		return [...queuedRows, ...sendingRows].map((row) => ({
			service: "SendMessage" as const,
			key: row._id,
			handler: "send",
		}));
	},
});

/** Worker: fetch single outgoing row by ID. */
export const getForWorker = workerQuery({
	args: { outgoingMessageId: v.id("outgoingMessages") },
	returns: v.union(outgoingMessageDoc, v.null()),
	handler: async (ctx, { outgoingMessageId }) => {
		return await ctx.db.get(outgoingMessageId);
	},
});

/** Worker: mark row actively sending, increment attempts. */
export const workerMarkSending = workerMutation({
	args: {
		outgoingMessageId: v.id("outgoingMessages"),
	},
	returns: result(
		v.null(),
		v.union(
			v.literal("Message not found"),
			v.literal("Message is terminal"),
			v.literal("Message already claimed"),
		),
	),
	handler: async (ctx, { outgoingMessageId }) => {
		const message = await ctx.db.get(outgoingMessageId);
		if (!message) {
			return err("Message not found");
		}
		if (message.status === "Sent" || message.status === "Failed") {
			return err("Message is terminal");
		}
		const now = Date.now();
		if (
			message.status === "Sending" &&
			message.lastAttemptedAt !== undefined &&
			now - message.lastAttemptedAt < sendingLeaseMs
		) {
			return err("Message already claimed");
		}

		await ctx.db.patch(message._id, {
			status: "Sending",
			attempts: message.attempts + 1,
			updatedAt: now,
			lastAttemptedAt: now,
			error: undefined,
		});

		return ok(null);
	},
});

/** Worker: mark row successfully sent store external message ID. */
export const workerMarkSent = workerMutation({
	args: {
		outgoingMessageId: v.id("outgoingMessages"),
		externalMessageId: v.string(),
	},
	returns: result(v.null(), v.literal("Message not found")),
	handler: async (ctx, { outgoingMessageId, externalMessageId }) => {
		const message = await ctx.db.get(outgoingMessageId);
		if (!message) {
			return err("Message not found");
		}

		await ctx.db.patch(message._id, {
			status: "Sent",
			externalMessageId,
			updatedAt: Date.now(),
			error: undefined,
		});

		return ok(null);
	},
});

/** Worker: mark row terminally failed. */
export const workerMarkFailed = workerMutation({
	args: {
		outgoingMessageId: v.id("outgoingMessages"),
		error: v.string(),
	},
	returns: result(v.null(), v.literal("Message not found")),
	handler: async (ctx, { outgoingMessageId, error }) => {
		const message = await ctx.db.get(outgoingMessageId);
		if (!message) {
			return err("Message not found");
		}

		await ctx.db.patch(message._id, {
			status: "Failed",
			error,
			updatedAt: Date.now(),
		});

		return ok(null);
	},
});

export type OutgoingMessageForWorker = Infer<typeof outgoingMessageDoc>;
