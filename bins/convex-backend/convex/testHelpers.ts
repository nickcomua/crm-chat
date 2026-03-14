/**
 * Robot-only mutations for E2E test data seeding.
 * These bypass task validation and human-auth checks to allow
 * the test robot client to insert data directly.
 *
 * NEVER import these in production code.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireWorker } from "./helpers/auth";
import {
	chatType,
	forwardedFromValidator,
	mediaKind,
	mediaStatus,
	messageSeverity,
	reactionValidator,
} from "./schema";

/** Insert a notification directly (no internal trigger needed). */
export const seedNotification = mutation({
	args: {
		userId: v.string(),
		severity: messageSeverity,
		message: v.string(),
	},
	returns: v.id("notifications"),
	handler: async (ctx, args) => {
		await requireWorker(ctx);
		return await ctx.db.insert("notifications", {
			...args,
			dismissed: false,
		});
	},
});

/** Upsert a chat. Robot-accessible version of chats.upsert for test seeding. */
export const seedChat = mutation({
	args: {
		chatId: v.string(),
		userId: v.string(),
		clientId: v.id("clients"),
		chatType,
		isPinned: v.boolean(),
		pinnedName: v.optional(v.string()),
		lastMessageTimestamp: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireWorker(ctx);
		const existing = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				chatType: args.chatType,
				isPinned: args.isPinned,
				pinnedName: args.pinnedName,
				lastMessageTimestamp: args.lastMessageTimestamp,
				scanEnabled: args.isPinned,
			});
		} else {
			await ctx.db.insert("chats", {
				...args,
				scanEnabled: args.isPinned,
			});
		}
		return null;
	},
});

/** Insert a media record at any status, bypassing task validation. */
export const seedMediaRecord = mutation({
	args: {
		telegramFileId: v.string(),
		userId: v.string(),
		clientId: v.id("clients"),
		chatId: v.string(),
		messageId: v.string(),
		kind: mediaKind,
		status: mediaStatus,
		mimeType: v.optional(v.string()),
		fileName: v.optional(v.string()),
		fileSize: v.optional(v.number()),
		error: v.optional(v.string()),
		downloadedAt: v.optional(v.number()),
	},
	returns: v.id("media"),
	handler: async (ctx, args) => {
		await requireWorker(ctx);
		return await ctx.db.insert("media", args);
	},
});

/** Insert a message with optional reply/forward/reaction fields. */
export const seedMessage = mutation({
	args: {
		messageId: v.string(),
		externalId: v.string(),
		userId: v.string(),
		clientId: v.id("clients"),
		chatId: v.string(),
		senderId: v.string(),
		text: v.optional(v.string()),
		outgoing: v.boolean(),
		deleted: v.boolean(),
		timestamp: v.number(),
		mediaExternalId: v.optional(v.string()),
		mediaKind: v.optional(mediaKind),
		replyToMessageId: v.optional(v.string()),
		replyToText: v.optional(v.string()),
		forwardedFrom: v.optional(forwardedFromValidator),
		reactions: v.optional(v.array(reactionValidator)),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireWorker(ctx);

		const existing = await ctx.db
			.query("messages")
			.withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, args);
		} else {
			await ctx.db.insert("messages", args);
		}
		return null;
	},
});

/** Delete a single client by ID. Robot-accessible version of clients.deleteClient. */
export const deleteClient = mutation({
	args: { clientId: v.id("clients") },
	returns: v.null(),
	handler: async (ctx, { clientId }) => {
		await requireWorker(ctx);
		const client = await ctx.db.get(clientId);
		if (!client) return null;

		// Cancel phone auths
		const phoneAuths = await ctx.db
			.query("phoneAuths")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();
		for (const auth of phoneAuths) {
			await ctx.db.delete(auth._id);
		}

		// Cancel worker tasks for this client
		const tasks = await ctx.db
			.query("workerTasks")
			.withIndex("by_userId", (q) => q.eq("userId", client.userId))
			.collect();
		for (const t of tasks) {
			if ("clientId" in t.task && t.task.clientId === clientId) {
				await ctx.db.delete(t._id);
			}
		}

		// Delete chats for this client
		const chats = await ctx.db
			.query("chats")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();
		for (const c of chats) {
			await ctx.db.delete(c._id);
		}

		await ctx.db.delete(clientId);
		return null;
	},
});

// =============================================================================
// Robot-accessible queries for test verification
// =============================================================================

/** List messages by chatId (no pagination, up to 200). Robot-accessible. */
export const queryMessages = query({
	args: { chatId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, { chatId, limit }) => {
		await requireWorker(ctx);
		return await ctx.db
			.query("messages")
			.withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
			.order("desc")
			.take(limit ?? 200);
	},
});

/** Get last message per chat. Robot-accessible version of messages.getLastPerChat. */
export const queryLastPerChat = query({
	args: { chatIds: v.array(v.string()) },
	handler: async (ctx, { chatIds }) => {
		await requireWorker(ctx);
		const results: Array<{
			chatId: string;
			text?: string;
			mediaExternalId?: string;
			mediaKind?: string;
		}> = [];
		for (const chatId of chatIds) {
			const msg = await ctx.db
				.query("messages")
				.withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
				.order("desc")
				.first();
			if (msg) {
				results.push({
					chatId,
					text: msg.text,
					mediaExternalId: msg.mediaExternalId,
					mediaKind: msg.mediaKind,
				});
			}
		}
		return results;
	},
});

/** List chats for a user. Robot-accessible version of chats.list. */
export const queryChats = query({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		await requireWorker(ctx);
		return await ctx.db
			.query("chats")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
	},
});

/** Count media records by status for a user. Robot-accessible. */
export const queryMediaCountByStatus = query({
	args: { userId: v.string(), statuses: v.array(mediaStatus) },
	handler: async (ctx, { userId, statuses }) => {
		await requireWorker(ctx);
		const results: Record<string, number> = {};
		for (const status of statuses) {
			const records = await ctx.db
				.query("media")
				.withIndex("by_userId_status", (q) =>
					q.eq("userId", userId).eq("status", status),
				)
				.collect();
			results[status] = records.length;
		}
		return results;
	},
});

/** List media by status for a user. Robot-accessible. */
export const queryMediaByStatus = query({
	args: { userId: v.string(), statuses: v.array(mediaStatus) },
	handler: async (ctx, { userId, statuses }) => {
		await requireWorker(ctx);
		const all = [];
		for (const status of statuses) {
			const records = await ctx.db
				.query("media")
				.withIndex("by_userId_status", (q) =>
					q.eq("userId", userId).eq("status", status),
				)
				.collect();
			all.push(...records);
		}
		return all;
	},
});

/** Retry a failed media download. Robot-accessible (no task enqueue). */
export const retryDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		await requireWorker(ctx);
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();
		if (!existing || existing.status !== "Failed") return null;
		await ctx.db.patch(existing._id, {
			status: "Pending" as const,
			error: undefined,
			bytesDownloaded: undefined,
		});
		return null;
	},
});

/** Cancel a pending media download. Robot-accessible. */
export const cancelDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		await requireWorker(ctx);
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();
		if (!existing) return null;
		if (existing.status !== "Pending" && existing.status !== "Downloading")
			return null;
		await ctx.db.patch(existing._id, {
			status: "Skipped" as const,
			bytesDownloaded: undefined,
			error: undefined,
		});
		return null;
	},
});

/** Delete all data for a user. For test cleanup / empty-state tests. */
export const deleteAllForUser = mutation({
	args: { userId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId }) => {
		await requireWorker(ctx);

		// Delete notifications
		const notifications = await ctx.db
			.query("notifications")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const n of notifications) {
			await ctx.db.delete(n._id);
		}

		// Delete media
		const media = await ctx.db
			.query("media")
			.withIndex("by_userId_status", (q) => q.eq("userId", userId))
			.collect();
		for (const m of media) {
			await ctx.db.delete(m._id);
		}

		// Delete messages
		const messages = await ctx.db
			.query("messages")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const m of messages) {
			await ctx.db.delete(m._id);
		}

		// Delete worker tasks
		const tasks = await ctx.db
			.query("workerTasks")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const t of tasks) {
			await ctx.db.delete(t._id);
		}

		// Delete chats
		const chats = await ctx.db
			.query("chats")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const c of chats) {
			await ctx.db.delete(c._id);
		}

		// Delete clients
		const clients = await ctx.db
			.query("clients")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const c of clients) {
			await ctx.db.delete(c._id);
		}

		// Delete phone auths
		const phoneAuths = await ctx.db
			.query("phoneAuths")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const p of phoneAuths) {
			await ctx.db.delete(p._id);
		}

		return null;
	},
});

/** Full-text search messages via Convex search index. Robot-accessible for E2E tests. */
export const searchMessages = query({
	args: {
		searchText: v.string(),
		userId: v.string(),
		chatId: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { searchText, userId, chatId, limit }) => {
		await requireWorker(ctx);
		const take = Math.min(limit ?? 20, 100);

		const results = await ctx.db
			.query("messages")
			.withSearchIndex("search_text", (s) => {
				const base = s.search("text", searchText).eq("userId", userId);
				if (chatId) {
					return base.eq("chatId", chatId);
				}
				return base;
			})
			.take(take);

		return results.map((msg) => ({
			messageId: msg.messageId,
			chatId: msg.chatId,
			text: msg.text,
			senderId: msg.senderId,
			timestamp: msg.timestamp,
		}));
	},
});

/** Query all worker tasks for a user (any status). For E2E assertions. */
export const queryWorkerTasks = query({
	args: { userId: v.string() },
	returns: v.array(
		v.object({
			status: v.string(),
			taskType: v.string(),
		}),
	),
	handler: async (ctx, { userId }) => {
		await requireWorker(ctx);
		const tasks = await ctx.db
			.query("workerTasks")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		return tasks.map((t) => ({
			status: t.status,
			taskType: t.task.type,
		}));
	},
});
