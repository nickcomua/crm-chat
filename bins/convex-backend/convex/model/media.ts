import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
	humanMutation,
	humanQuery,
	workerMutation,
	workerQuery,
} from "../functions";
import { mediaKind, mediaStatus } from "../helpers/validators";

// =============================================================================
// Table-specific validators
// =============================================================================

const mediaFields = v.object({
	telegramFileId: v.string(),
	userId: v.string(),
	clientId: v.id("clients"),
	chatId: v.string(),
	messageId: v.string(),
	status: mediaStatus,
	storageId: v.optional(v.id("_storage")),
	kind: mediaKind,
	mimeType: v.optional(v.string()),
	fileName: v.optional(v.string()),
	fileSize: v.optional(v.number()),
	bytesDownloaded: v.optional(v.number()),
	downloadedAt: v.optional(v.number()),
	width: v.optional(v.number()),
	height: v.optional(v.number()),
	duration: v.optional(v.number()),
	error: v.optional(v.string()),
});

export const mediaDoc = mediaFields.extend({
	_id: v.id("media"),
	_creationTime: v.number(),
});

export const mediaTable = defineTable(mediaFields)
	.index("by_telegramFileId", ["telegramFileId"])
	.index("by_messageId", ["messageId"])
	.index("by_clientId_status", ["clientId", "status"])
	.index("by_chatId", ["chatId"])
	.index("by_userId_status", ["userId", "status"])
	.index("by_userId_downloadedAt", ["userId", "downloadedAt"])
	.index("by_userId_status_downloadedAt", ["userId", "status", "downloadedAt"]);

/** Generate a short-lived upload URL for Convex file storage. */
export const generateUploadUrl = workerMutation({
	args: {},
	returns: v.string(),
	handler: async (ctx) => {
		return await ctx.storage.generateUploadUrl();
	},
});

/** Reset a failed media record back to pending so the worker retries it.
 *  Domain-driven: setting status to "Pending" causes the reconciler to
 *  dispatch a MediaDownloader automatically. */
export const retryDownload = humanMutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
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

		return null;
	},
});

/** Cancel a pending or downloading media record (human-callable). */
export const cancelDownload = humanMutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing) {
			return null;
		}
		if (existing.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

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

/** Request download for a skipped media record (human-callable).
 *  Domain-driven: setting status to "Pending" causes the reconciler to
 *  dispatch a MediaDownloader automatically. */
export const requestDownload = humanMutation({
	args: { telegramFileId: v.string() },
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing) {
			return null;
		}
		if (existing.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		if (existing.status !== "Skipped") {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "Pending" as const,
		});

		return null;
	},
});

/** Get media records for a batch of message IDs, including storage URLs. */
export const getForMessages = humanQuery({
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
export const getForChat = humanQuery({
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

/** Get media records for a batch of chats in one roundtrip. Verifies
 *  ownership per chat so cross-user reads are impossible. Used by the
 *  merged-timeline view to build a single mediaMap across N chats. */
const MAX_MEDIA_CHAT_IDS = 100;
export const getForChats = humanQuery({
	args: { chatIds: v.array(v.string()) },
	returns: v.array(
		v.object({
			telegramFileId: v.string(),
			messageId: v.string(),
			chatId: v.string(),
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
	handler: async (ctx, { chatIds }) => {
		if (chatIds.length > MAX_MEDIA_CHAT_IDS) {
			return [];
		}
		const results = [];
		for (const chatId of chatIds) {
			const chat = await ctx.db
				.query("chats")
				.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
				.unique();
			if (!chat || chat.userId !== ctx.caller.tokenIdentifier) {
				continue;
			}
			const allMedia = await ctx.db
				.query("media")
				.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
				.collect();
			for (const media of allMedia) {
				let url: string | undefined;
				if (media.status === "Stored" && media.storageId) {
					const storageUrl = await ctx.storage.getUrl(media.storageId);
					url = storageUrl ?? undefined;
				}
				results.push({
					telegramFileId: media.telegramFileId,
					messageId: media.messageId,
					chatId: media.chatId,
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
		}
		return results;
	},
});

/** List pending + downloading media records for a client. Worker-only. */
export const listPendingForClient = workerQuery({
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
export const listByStatus = humanQuery({
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
		const chatNameCache = new Map<string, string | undefined>();
		async function getChatName(chatId: string): Promise<string | undefined> {
			if (chatNameCache.has(chatId)) {
				return chatNameCache.get(chatId);
			}
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
			let limit: number;
			if (status === "Stored") {
				limit = 20;
			} else if (status === "Pending") {
				limit = 5;
			} else {
				limit = 100;
			}

			const records =
				status === "Stored"
					? await ctx.db
							.query("media")
							.withIndex("by_userId_status_downloadedAt", (q) =>
								q
									.eq("userId", ctx.caller.tokenIdentifier)
									.eq("status", "Stored"),
							)
							.order("desc")
							.take(limit)
					: await ctx.db
							.query("media")
							.withIndex("by_userId_status", (q) =>
								q.eq("userId", ctx.caller.tokenIdentifier).eq("status", status),
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
export const countByStatusForChat = humanQuery({
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
export const countByStatus = humanQuery({
	args: { statuses: v.array(mediaStatus) },
	returns: v.array(v.object({ status: mediaStatus, count: v.number() })),
	handler: async (ctx, { statuses }) => {
		const results = [];
		for (const status of statuses) {
			const records = await ctx.db
				.query("media")
				.withIndex("by_userId_status", (q) =>
					q.eq("userId", ctx.caller.tokenIdentifier).eq("status", status),
				)
				.collect();
			results.push({ status, count: records.length });
		}
		return results;
	},
});

// =============================================================================
// Cancel-watcher query (for domain-driven dispatch)
// =============================================================================

/**
 * Lightweight status query for domain cancel-watcher.
 * Rust handler subscribes to this and cancels when status becomes "Skipped".
 */
export const getStatus = workerQuery({
	args: { mediaId: v.id("media") },
	returns: v.union(mediaStatus, v.null()),
	handler: async (ctx, { mediaId }) => {
		const media = await ctx.db.get(mediaId);
		return media?.status ?? null;
	},
});

/** Get a media record by _id for the download handler. Worker-only. */
export const getForDownload = workerQuery({
	args: { mediaId: v.id("media") },
	returns: v.union(mediaDoc, v.null()),
	handler: async (ctx, { mediaId }) => {
		return await ctx.db.get(mediaId);
	},
});

// =============================================================================
// Worker domain operations (moved from domainOps.ts)
// =============================================================================

/** Create a pending media record. Worker-only.
 *  Domain-driven: no task enqueue — the reconciler dispatches MediaDownloader
 *  when it sees media records with status "Pending". */
export const workerCreatePendingMedia = workerMutation({
	args: {
		telegramFileId: v.string(),
		userId: v.string(),
		clientId: v.id("clients"),
		chatId: v.string(),
		messageId: v.string(),
		kind: mediaKind,
		mimeType: v.optional(v.string()),
		fileName: v.optional(v.string()),
		fileSize: v.optional(v.number()),
		width: v.optional(v.number()),
		height: v.optional(v.number()),
		duration: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", args.telegramFileId),
			)
			.unique();

		if (existing) {
			return null;
		}

		await ctx.db.insert("media", {
			...args,
			status: "Pending" as const,
		});

		return null;
	},
});

/** Transition a media record to "Downloading". Worker-only. */
export const workerStartMediaDownload = workerMutation({
	args: {
		telegramFileId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, { telegramFileId }) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing || existing.status !== "Pending") {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "Downloading" as const,
			bytesDownloaded: 0,
		});
		return null;
	},
});

/** Update download progress. Worker-only. */
export const workerUpdateMediaProgress = workerMutation({
	args: {
		telegramFileId: v.string(),
		bytesDownloaded: v.number(),
		fileSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, { telegramFileId, bytesDownloaded, fileSize }) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing || existing.status !== "Downloading") {
			return null;
		}

		const patch: Record<string, number> = { bytesDownloaded };
		if (fileSize !== undefined && fileSize > 0) {
			patch.fileSize = fileSize;
		}
		await ctx.db.patch(existing._id, patch);
		return null;
	},
});

/** Store media file after successful upload. Worker-only. */
export const workerStoreMedia = workerMutation({
	args: {
		telegramFileId: v.string(),
		storageId: v.id("_storage"),
		mimeType: v.optional(v.string()),
		fileName: v.optional(v.string()),
		fileSize: v.optional(v.number()),
		width: v.optional(v.number()),
		height: v.optional(v.number()),
		duration: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", args.telegramFileId),
			)
			.unique();

		if (!existing) {
			await ctx.storage.delete(args.storageId);
			return null;
		}

		if (existing.status !== "Downloading" && existing.status !== "Pending") {
			await ctx.storage.delete(args.storageId);
			return null;
		}

		const { telegramFileId: _, ...updates } = args;
		await ctx.db.patch(existing._id, {
			...updates,
			status: "Stored" as const,
			downloadedAt: Date.now(),
		});
		return null;
	},
});

/** Mark a media record as failed. Worker-only. */
export const workerMarkMediaFailed = workerMutation({
	args: {
		telegramFileId: v.string(),
		error: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, { telegramFileId, error: errorMsg }) => {
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) =>
				q.eq("telegramFileId", telegramFileId),
			)
			.unique();

		if (!existing) {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "Failed" as const,
			error: errorMsg,
		});
		return null;
	},
});

// =============================================================================
// Pending work (for reconciler dispatch)
// =============================================================================

/** Media records needing download, with optional concurrency limit. */
export const pendingWork = workerQuery({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		const pending = await ctx.db
			.query("media")
			.filter((q) => q.eq(q.field("status"), "Pending"))
			.collect();
		const downloading = await ctx.db
			.query("media")
			.filter((q) => q.eq(q.field("status"), "Downloading"))
			.collect();
		return [...pending, ...downloading].map((m) => m._id);
	},
});
