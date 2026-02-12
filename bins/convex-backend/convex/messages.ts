import { mutation, query } from "./_generated/server";
import { ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
	isRobotCaller,
	requireAuth,
	requireHuman,
	requireOwner,
} from "./helpers/auth";
import { mediaKind } from "./schema";

const MAX_CHAT_IDS = 100;

/** Get the last message for each of the given chats (for chat-list previews). */
export const getLastPerChat = query({
	args: { chatIds: v.array(v.string()) },
	returns: v.array(
		v.object({
			chatId: v.string(),
			text: v.optional(v.string()),
			mediaId: v.optional(v.string()),
			mediaKind: v.optional(mediaKind),
		}),
	),
	handler: async (ctx, { chatIds }) => {
		if (chatIds.length > MAX_CHAT_IDS) {
			throw new ConvexError(`Too many chatIds (max ${MAX_CHAT_IDS})`);
		}
		const caller = await requireHuman(ctx);

		// Verify chat ownership and fetch last messages in parallel
		const entries = await Promise.all(
			chatIds.map(async (chatId) => {
				const chat = await ctx.db
					.query("chats")
					.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
					.unique();
				if (!chat || chat.userId !== caller.id) return null;

				const msg = await ctx.db
					.query("messages")
					.withIndex("by_chatId_ts", (q) => q.eq("chatId", chatId))
					.order("desc")
					.first();
				if (!msg) return null;
				return { chatId, text: msg.text, mediaId: msg.mediaId, mediaKind: msg.mediaKind };
			}),
		);
		return entries.filter((e): e is NonNullable<typeof e> => e !== null);
	},
});

/** List messages for a specific chat, paginated (newest first). */
export const listByChat = query({
	args: { chatId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { chatId, paginationOpts }) => {
		const caller = await requireHuman(ctx);

		// Verify the caller owns this chat
		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat) {
			throw new Error("Chat not found");
		}
		requireOwner(caller.id, chat.userId);

		return await ctx.db
			.query("messages")
			.withIndex("by_chatId_ts", (q) => q.eq("chatId", chatId))
			.order("desc")
			.paginate(paginationOpts);
	},
});

/** Upsert a message. Callable by owner or robot. */
export const upsert = mutation({
	args: {
		messageId: v.string(),
		externalId: v.string(),
		userId: v.string(),
		clientId: v.id("clients"),
		chatId: v.string(),
		senderId: v.string(),
		text: v.optional(v.string()),
		out: v.boolean(),
		deleted: v.boolean(),
		ts: v.number(),
		mediaId: v.optional(v.string()),
		mediaKind: v.optional(mediaKind),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const caller = await requireAuth(ctx);

		const isRobot = isRobotCaller(caller);
		if (!isRobot) {
			requireOwner(caller.id, args.userId);
		}

		const existing = await ctx.db
			.query("messages")
			.withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				text: args.text,
				out: args.out,
				deleted: args.deleted,
				ts: args.ts,
				mediaId: args.mediaId,
				mediaKind: args.mediaKind,
			});
		} else {
			await ctx.db.insert("messages", args);
		}

		// Auto-create pending media record if this message has media
		const { mediaId: mid, mediaKind: mk } = args;
		if (mid && mk) {
			const existingMedia = await ctx.db
				.query("media")
				.withIndex("by_externalId", (q) => q.eq("externalId", mid))
				.unique();

			if (!existingMedia) {
				await ctx.db.insert("media", {
					externalId: mid,
					userId: args.userId,
					clientId: args.clientId,
					chatId: args.chatId,
					messageId: args.messageId,
					status: "pending" as const,
					kind: mk,
				});
			}
		}
	},
});

/** Soft-delete a message by external ID. */
export const markDeleted = mutation({
	args: { externalId: v.string() },
	returns: v.null(),
	handler: async (ctx, { externalId }) => {
		const caller = await requireAuth(ctx);

		const messages = await ctx.db
			.query("messages")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.collect();

		if (messages.length !== 1) {
			throw new Error("Message not found or ambiguous (multiple matches)");
		}

		const msg = messages[0];
		const isRobot = isRobotCaller(caller);
		if (!isRobot) {
			requireOwner(caller.id, msg.userId);
		}

		await ctx.db.patch(msg._id, { deleted: true });
	},
});
