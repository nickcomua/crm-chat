import { v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { internal } from "./_generated/api";
import { query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import {
	requireHuman,
	requireOwner,
	requireWorker,
} from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueTask } from "./helpers/tasks";
import {
	chatDoc,
	chatListItem,
	chatType,
	mediaSettingsValidator,
} from "./schema";

/** List scan-enabled chats for the current user, sorted by last message time (newest first). */
export const list = query({
	args: {},
	returns: v.array(chatListItem),
	handler: async (ctx) => {
		const caller = await requireHuman(ctx);
		const chats = await ctx.db
			.query("chats")
			.withIndex("by_userId_scanEnabled_lastMessageTimestamp", (q) =>
				q.eq("userId", caller.id).eq("scanEnabled", true),
			)
			.order("desc")
			.collect();

		return asyncMap(chats, async (chat) => {
			let photoUrl: string | undefined;
			if (chat.photoStorageId) {
				const url = await ctx.storage.getUrl(chat.photoStorageId);
				photoUrl = url ?? undefined;
			}
			return { ...chat, photoUrl };
		});
	},
});

/** Upsert a chat. Human-only (workers use workerOps.upsertChat). */
export const upsert = mutation({
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
		const caller = await requireHuman(ctx);
		requireOwner(caller.id, args.userId);

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
			});
		} else {
			await ctx.db.insert("chats", {
				...args,
				scanEnabled: false,
			});
		}
		return null;
	},
});

/** Delete a chat by its chatId. Human-only. */
export const deleteChat = mutation({
	args: { chatId: v.string() },
	returns: v.null(),
	handler: async (ctx, { chatId }) => {
		const caller = await requireHuman(ctx);

		const existing = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();

		if (existing) {
			requireOwner(caller.id, existing.userId);
			await ctx.db.delete(existing._id);
		}
		return null;
	},
});

/** List chats for a specific client. Human-only. */
export const listByClient = query({
	args: { clientId: v.id("clients") },
	returns: v.array(chatDoc),
	handler: async (ctx, { clientId }) => {
		const caller = await requireHuman(ctx);
		return await ctx.db
			.query("chats")
			.withIndex("by_clientId_userId", (q) =>
				q.eq("clientId", clientId).eq("userId", caller.id),
			)
			.collect();
	},
});

/** Update a chat's custom display name. Human-only. */
export const updatePinnedName = mutation({
	args: { chatId: v.string(), pinnedName: v.optional(v.string()) },
	returns: result(v.null(), v.literal("Chat not found")),
	handler: async (ctx, { chatId, pinnedName }) => {
		const caller = await requireHuman(ctx);
		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat) return err("Chat not found");
		requireOwner(caller.id, chat.userId);
		await ctx.db.patch(chat._id, { pinnedName });
		return ok(null);
	},
});

/** Toggle scanning for a specific chat. Human-only.
 *  Turning OFF resets fullScanned and schedules data purge (messages + media).
 *  Turning ON triggers a fresh rescan since fullScanned is already false. */
export const updateScanEnabled = mutation({
	args: { chatId: v.string(), scanEnabled: v.boolean() },
	returns: result(v.null(), v.literal("Chat not found")),
	handler: async (ctx, { chatId, scanEnabled }) => {
		const caller = await requireHuman(ctx);
		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat) return err("Chat not found");
		requireOwner(caller.id, chat.userId);
		if (!scanEnabled) {
			await ctx.db.patch(chat._id, { scanEnabled, fullScanned: false });
			await ctx.scheduler.runAfter(0, internal.chats.purgeChatData, { chatId });
		} else {
			// Always reset fullScanned so the scanner re-runs from scratch.
			// Without this, toggling OFF→ON on an already-scanned chat would
			// read the stale `fullScanned: true` and skip the enqueue.
			await ctx.db.patch(chat._id, { scanEnabled, fullScanned: false });
			await enqueueTask(ctx, {
				type: "ChatScanner",
				chatId,
				clientId: chat.clientId,
				userId: chat.userId,
				isPinned: chat.isPinned,
				pinnedName: chat.pinnedName,
			});
		}
		return ok(null);
	},
});

const PURGE_BATCH_SIZE = 200;

/** Delete all messages and media for a chat in batches. Self-scheduling.
 *  Stops early if the chat has been re-enabled (to avoid racing with a new scan). */
// TODO buillshit
export const purgeChatData = internalMutation({
	args: { chatId: v.string() },
	handler: async (ctx, { chatId }) => {
		// Guard: stop purging if scan was re-enabled since the purge was scheduled
		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat || chat.scanEnabled) {
			return;
		}

		let hasMore = false;

		// Delete messages in batch
		const messages = await ctx.db
			.query("messages")
			.withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
			.take(PURGE_BATCH_SIZE);
		for (const msg of messages) {
			await ctx.db.delete(msg._id);
		}
		if (messages.length === PURGE_BATCH_SIZE) {
			hasMore = true;
		}

		// Delete media in batch (also clean up storage files)
		const mediaRecords = await ctx.db
			.query("media")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.take(PURGE_BATCH_SIZE);
		for (const media of mediaRecords) {
			if (media.storageId) {
				await ctx.storage.delete(media.storageId);
			}
			await ctx.db.delete(media._id);
		}
		if (mediaRecords.length === PURGE_BATCH_SIZE) {
			hasMore = true;
		}

		// Re-schedule if more records remain
		if (hasMore) {
			await ctx.scheduler.runAfter(0, internal.chats.purgeChatData, { chatId });
		}
	},
});

/** Return chatIds of scan-enabled chats for a client. Worker-only. */
export const scanEnabledChatIds = query({
	args: { clientId: v.id("clients") },
	returns: v.array(v.string()),
	handler: async (ctx, { clientId }) => {
		await requireWorker(ctx);
		const chats = await ctx.db
			.query("chats")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();
		return chats.filter((c) => c.scanEnabled).map((c) => c.chatId);
	},
});

/** Update per-chat media download settings. Human-only. */
export const updateMediaSettings = mutation({
	args: { chatId: v.string(), mediaSettings: mediaSettingsValidator },
	returns: result(v.null(), v.literal("Chat not found")),
	handler: async (ctx, { chatId, mediaSettings }) => {
		const caller = await requireHuman(ctx);
		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat) return err("Chat not found");
		requireOwner(caller.id, chat.userId);
		await ctx.db.patch(chat._id, { mediaSettings });
		return ok(null);
	},
});

/** Re-scan all messages for a chat without purging data. Human-only.
 *  Resets fullScanned so the worker picks it up on the next refresh cycle. */
export const rescan = mutation({
	args: { chatId: v.string() },
	returns: result(v.null(), v.union(v.literal("Chat not found"), v.literal("Chat scanning is not enabled"))),
	handler: async (ctx, { chatId }) => {
		const caller = await requireHuman(ctx);
		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat) return err("Chat not found");
		requireOwner(caller.id, chat.userId);
		if (!chat.scanEnabled) return err("Chat scanning is not enabled");
		await ctx.db.patch(chat._id, {
			fullScanned: false,
			// TODO wtf
			syncedMessages: undefined,
			totalMessages: undefined,
			scanPhase: undefined,
		});

		// Enqueue scan task
		await enqueueTask(ctx, {
			type: "ChatScanner",
			chatId,
			clientId: chat.clientId,
			userId: chat.userId,
			isPinned: chat.isPinned,
			pinnedName: chat.pinnedName,
		});

		return ok(null);
	},
});

