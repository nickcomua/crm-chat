import { v } from "convex/values";
import { query  } from "./_generated/server";
import { mutation } from "./functions";
import {
	requireAuth,
	requireHuman,
	requireOwner,
	requireWorker,
} from "./helpers/auth";
import { enqueueTask } from "./helpers/tasks";
import { mediaKind, mediaStatus } from "./schema";

/** Generate a short-lived upload URL for Convex file storage. */
export const generateUploadUrl = mutation({
	args: {},
	returns: v.string(),
	handler: async (ctx) => {
		await requireAuth(ctx);
		return await ctx.storage.generateUploadUrl();
	},
});

/** Reset a failed media record back to pending so the worker retries it. */
export const retryDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing || existing.status !== "Failed") {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "Pending" as const,
			error: undefined,
			bytesDownloaded: undefined,
		});

		const client = await ctx.db.get(existing.clientId);
		if (client) {
			await enqueueTask(ctx, {
				type: "MediaDownloader",
				telegramFileId: existing.telegramFileId,
				userId: existing.userId,
				clientId: existing.clientId,
				telegramId: client.telegramId,
				chatId: existing.chatId,
				kind: existing.kind,
				mimeType: existing.mimeType,
				fileSize: existing.fileSize,
			});
		}

		return null;
	},
});

/** Cancel a pending or downloading media record (human-callable). */
export const cancelDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		const caller = await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing) return null;
		requireOwner(caller.id, existing.userId);

		if (existing.status !== "Pending" && existing.status !== "Downloading") {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "Skipped" as const,
			bytesDownloaded: undefined,
			error: undefined,
		});
		return null;
	},
});

/** Request download for a skipped media record (human-callable). */
export const requestDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		const caller = await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing) return null;
		requireOwner(caller.id, existing.userId);

		if (existing.status !== "Skipped") return null;

		await ctx.db.patch(existing._id, {
			status: "Pending" as const,
		});

		const client = await ctx.db.get(existing.clientId);
		if (client) {
			await enqueueTask(ctx, {
				type: "MediaDownloader",
				telegramFileId: existing.telegramFileId,
				userId: existing.userId,
				clientId: existing.clientId,
				telegramId: client.telegramId,
				chatId: existing.chatId,
				kind: existing.kind,
				mimeType: existing.mimeType,
				fileSize: existing.fileSize,
			});
		}

		return null;
	},
});

/** Get media records for a batch of message IDs, including storage URLs. */
export const getForMessages = query({
	args: { messageIds: v.array(v.string()) },
	returns: v.array(
		v.object({
			messageId: v.string(),
			kind: mediaKind,
			status: mediaStatus,
			url: v.optional(v.string()),
			mimeType: v.optional(v.string()),
			fileName: v.optional(v.string()),
			fileSize: v.optional(v.number()),
			bytesDownloaded: v.optional(v.number()),
			width: v.optional(v.number()),
			height: v.optional(v.number()),
			duration: v.optional(v.number()),
		}),
	),
	handler: async (ctx, { messageIds }) => {
		await requireHuman(ctx);

		const results = [];
		for (const messageId of messageIds) {
			const media = await ctx.db
				.query("media")
				.withIndex("by_messageId", (q) => q.eq("messageId", messageId))
				.unique();

			if (!media) {
				continue;
			}

			let url: string | undefined;
			if (media.status === "Stored" && media.storageId) {
				const storageUrl = await ctx.storage.getUrl(media.storageId);
				url = storageUrl ?? undefined;
			}

			results.push({
				messageId: media.messageId,
				kind: media.kind,
				status: media.status,
				url,
				mimeType: media.mimeType,
				fileName: media.fileName,
				fileSize: media.fileSize,
				bytesDownloaded: media.bytesDownloaded,
				width: media.width,
				height: media.height,
				duration: media.duration,
			});
		}

		return results;
	},
});

/** Get all media records for a chat in a single indexed scan. */
export const getForChat = query({
	args: { chatId: v.string() },
	returns: v.array(
		v.object({
			telegramFileId: v.string(),
			messageId: v.string(),
			kind: mediaKind,
			status: mediaStatus,
			url: v.optional(v.string()),
			mimeType: v.optional(v.string()),
			fileName: v.optional(v.string()),
			fileSize: v.optional(v.number()),
			bytesDownloaded: v.optional(v.number()),
			width: v.optional(v.number()),
			height: v.optional(v.number()),
			duration: v.optional(v.number()),
		}),
	),
	handler: async (ctx, { chatId }) => {
		await requireHuman(ctx);

		const allMedia = await ctx.db
			.query("media")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.collect();

		const results = [];
		for (const media of allMedia) {
			let url: string | undefined;
			if (media.status === "Stored" && media.storageId) {
				const storageUrl = await ctx.storage.getUrl(media.storageId);
				url = storageUrl ?? undefined;
			}

			results.push({
				telegramFileId: media.telegramFileId,
				messageId: media.messageId,
				kind: media.kind,
				status: media.status,
				url,
				mimeType: media.mimeType,
				fileName: media.fileName,
				fileSize: media.fileSize,
				bytesDownloaded: media.bytesDownloaded,
				width: media.width,
				height: media.height,
				duration: media.duration,
			});
		}

		return results;
	},
});

/** List pending + downloading media records for a client. Worker-only. */
export const listPendingForClient = query({
	args: { clientId: v.id("clients") },
	returns: v.array(
		v.object({
			telegramFileId: v.string(),
			messageId: v.string(),
			chatId: v.string(),
			kind: mediaKind,
			fileSize: v.optional(v.number()),
		}),
	),
	handler: async (ctx, { clientId }) => {
		await requireWorker(ctx);

		const downloading = await ctx.db
			.query("media")
			.withIndex("by_clientId_status", (q) =>
				q.eq("clientId", clientId).eq("status", "Downloading"),
			)
			.take(200);

		const pending = await ctx.db
			.query("media")
			.withIndex("by_clientId_status", (q) =>
				q.eq("clientId", clientId).eq("status", "Pending"),
			)
			.take(Math.max(0, 200 - downloading.length));

		return [...downloading, ...pending].map((m) => ({
			telegramFileId: m.telegramFileId,
			messageId: m.messageId,
			chatId: m.chatId,
			kind: m.kind,
			fileSize: m.fileSize,
		}));
	},
});

/** List media records by status for the download manager UI. */
export const listByStatus = query({
	args: { statuses: v.array(mediaStatus) },
	returns: v.array(
		v.object({
			telegramFileId: v.string(),
			messageId: v.string(),
			kind: mediaKind,
			status: mediaStatus,
			bytesDownloaded: v.optional(v.number()),
			fileSize: v.optional(v.number()),
			fileName: v.optional(v.string()),
			mimeType: v.optional(v.string()),
			chatId: v.string(),
			chatName: v.optional(v.string()),
			messageTs: v.optional(v.number()),
			error: v.optional(v.string()),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, { statuses }) => {
		const caller = await requireHuman(ctx);

		const chatNameCache = new Map<string, string | undefined>();
		async function getChatName(chatId: string): Promise<string | undefined> {
			if (chatNameCache.has(chatId)) return chatNameCache.get(chatId);
			const chat = await ctx.db
				.query("chats")
				.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
				.unique();
			const name = chat?.pinnedName ?? undefined;
			chatNameCache.set(chatId, name);
			return name;
		}

		const results = [];
		for (const status of statuses) {
			const limit = status === "Stored" ? 20 : status === "Pending" ? 5 : 100;

			const records =
				status === "Stored"
					? await ctx.db
							.query("media")
							.withIndex("by_userId_status_downloadedAt", (q) =>
								q.eq("userId", caller.id).eq("status", "Stored"),
							)
							.order("desc")
							.take(limit)
					: await ctx.db
							.query("media")
							.withIndex("by_userId_status", (q) =>
								q.eq("userId", caller.id).eq("status", status),
							)
							.order(
								status === "Pending" || status === "Downloading"
									? "asc"
									: "desc",
							)
							.take(limit);

			for (const m of records) {
				const message = await ctx.db
					.query("messages")
					.withIndex("by_messageId", (q) => q.eq("messageId", m.messageId))
					.unique();

				results.push({
					telegramFileId: m.telegramFileId,
					messageId: m.messageId,
					kind: m.kind,
					status: m.status,
					bytesDownloaded: m.bytesDownloaded,
					fileSize: m.fileSize,
					fileName: m.fileName,
					mimeType: m.mimeType,
					chatId: m.chatId,
					chatName: await getChatName(m.chatId),
					messageTs: message?.timestamp,
					error: m.error,
					createdAt: m.downloadedAt ?? m._creationTime,
				});
			}
		}

		return results;
	},
});

/** Return media counts per status for a specific chat (for progress UI). */
export const countByStatusForChat = query({
	args: { chatId: v.string() },
	returns: v.object({
		Pending: v.number(),
		Downloading: v.number(),
		Stored: v.number(),
		Failed: v.number(),
		Skipped: v.number(),
		total: v.number(),
	}),
	handler: async (ctx, { chatId }) => {
		await requireHuman(ctx);

		const allMedia = await ctx.db
			.query("media")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.collect();

		const counts = {
			Pending: 0,
			Downloading: 0,
			Stored: 0,
			Failed: 0,
			Skipped: 0,
			total: 0,
		};
		for (const m of allMedia) {
			counts[m.status as keyof typeof counts]++;
			counts.total++;
		}
		return counts;
	},
});

/** Return the count of media records for given statuses (for the UI badge). */
export const countByStatus = query({
	args: { statuses: v.array(mediaStatus) },
	returns: v.array(v.object({ status: mediaStatus, count: v.number() })),
	handler: async (ctx, { statuses }) => {
		const caller = await requireHuman(ctx);
		const results = [];
		for (const status of statuses) {
			const records = await ctx.db
				.query("media")
				.withIndex("by_userId_status", (q) =>
					q.eq("userId", caller.id).eq("status", status),
				)
				.collect();
			results.push({ status, count: records.length });
		}
		return results;
	},
});
