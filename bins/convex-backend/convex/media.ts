import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { mediaKind, mediaStatus } from "./schema";
import {
	isWorkerCaller,
	requireAuth,
	requireHuman,
	requireOwner,
} from "./helpers/auth";
import { err, ok, result } from "./helpers/result";

/** Generate a short-lived upload URL for Convex file storage. */
export const generateUploadUrl = mutation({
	args: {},
	returns: v.string(),
	handler: async (ctx) => {
		await requireAuth(ctx);
		return await ctx.storage.generateUploadUrl();
	},
});

/** Create a pending media record (called when a message with media is upserted). */
export const createPending = mutation({
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
	returns: result(v.null()),
	handler: async (ctx, args) => {
		const caller = await requireAuth(ctx);
		if (!isWorkerCaller(caller)) {
			return err("Unauthorized: only workers can create media records");
		}

		// Check if media record already exists for this telegramFileId
		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", args.telegramFileId))
			.unique();

		if (existing) {
			return ok(null);
		}

		await ctx.db.insert("media", {
			...args,
			status: "Pending" as const,
		});
		return ok(null);
	},
});

/** Store media file after successful upload. Patches existing pending record. */
export const storeMedia = mutation({
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
	returns: result(v.null()),
	handler: async (ctx, args) => {
		const caller = await requireAuth(ctx);
		if (!isWorkerCaller(caller)) {
			return err("Unauthorized: only workers can store media");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", args.telegramFileId))
			.unique();

		if (!existing) {
			// Record may have been deleted by purgeChatData — clean up orphaned storage
			await ctx.storage.delete(args.storageId);
			return ok(null);
		}

		// Guard: if the user cancelled (skipped) while we were uploading, don't overwrite
		if (existing.status !== "Downloading" && existing.status !== "Pending") {
			await ctx.storage.delete(args.storageId);
			return ok(null);
		}

		const { telegramFileId: _, ...updates } = args;
		await ctx.db.patch(existing._id, {
			...updates,
			status: "Stored" as const,
			downloadedAt: Date.now(),
		});
		return ok(null);
	},
});

/** Mark a media record as failed. */
export const markFailed = mutation({
	args: {
		telegramFileId: v.string(),
		error: v.string(),
	},
	returns: result(v.null()),
	handler: async (ctx, { telegramFileId, error: errorMsg }) => {
		const caller = await requireAuth(ctx);
		if (!isWorkerCaller(caller)) {
			return err("Unauthorized: only workers can mark media as failed");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", telegramFileId))
			.unique();

		if (!existing) {
			// Record may have been deleted by purgeChatData — nothing to mark
			return ok(null);
		}

		await ctx.db.patch(existing._id, {
			status: "Failed" as const,
			error: errorMsg,
		});
		return ok(null);
	},
});

/** Reset a failed media record back to pending so the worker retries it. */
export const retryDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: result(v.null()),
	handler: async (ctx, { telegramFileId }) => {
		await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", telegramFileId))
			.unique();

		if (!existing || existing.status !== "Failed") {
			return ok(null);
		}

		await ctx.db.patch(existing._id, {
			status: "Pending" as const,
			error: undefined,
			bytesDownloaded: undefined,
		});
		return ok(null);
	},
});

/** Mark a media record as skipped (filtered by settings). */
export const markSkipped = mutation({
	args: {
		telegramFileId: v.string(),
	},
	returns: result(v.null()),
	handler: async (ctx, { telegramFileId }) => {
		const caller = await requireAuth(ctx);
		if (!isWorkerCaller(caller)) {
			return err("Unauthorized: only workers can skip media");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", telegramFileId))
			.unique();

		if (!existing) {
			return err(`Media record not found: ${telegramFileId}`);
		}

		await ctx.db.patch(existing._id, {
			status: "Skipped" as const,
		});
		return ok(null);
	},
});

/** Transition a media record to "Downloading" status. Called at download start. */
export const startDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: result(v.null()),
	handler: async (ctx, { telegramFileId }) => {
		const caller = await requireAuth(ctx);
		if (!isWorkerCaller(caller)) {
			return err("Unauthorized: only workers can start downloads");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", telegramFileId))
			.unique();

		if (!existing || existing.status !== "Pending") {
			return ok(null);
		}

		await ctx.db.patch(existing._id, {
			status: "Downloading" as const,
			bytesDownloaded: 0,
		});
		return ok(null);
	},
});

/** Update download progress (bytes downloaded so far, and optionally total size). */
export const updateProgress = mutation({
	args: {
		telegramFileId: v.string(),
		bytesDownloaded: v.number(),
		fileSize: v.optional(v.number()),
	},
	returns: result(v.null()),
	handler: async (ctx, { telegramFileId, bytesDownloaded, fileSize }) => {
		const caller = await requireAuth(ctx);
		if (!isWorkerCaller(caller)) {
			return err("Unauthorized: only workers can update progress");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", telegramFileId))
			.unique();

		if (!existing || existing.status !== "Downloading") {
			return ok(null);
		}

		const patch: Record<string, number> = { bytesDownloaded };
		if (fileSize !== undefined && fileSize > 0) {
			patch.fileSize = fileSize;
		}
		await ctx.db.patch(existing._id, patch);
		return ok(null);
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

/** Get all media records for a chat in a single indexed scan.
 *  Much more efficient than getForMessages when loading many messages,
 *  as it avoids per-messageId reads that can exceed the 4096 read limit. */
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

/** List pending + downloading media records for a client (for background download task).
 *  Includes "Downloading" so interrupted downloads are retried on restart. */
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
		const caller = await requireAuth(ctx);
		if (!isWorkerCaller(caller)) {
			throw new Error("Unauthorized: only workers can list pending media");
		}

		// Prioritize interrupted downloads, then pending. Batch to stay under
		// Convex's 8192 array-length return limit — the subscriber processes
		// these sequentially, so it will fetch the next batch on the next call.
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

		// Build a small cache so we don't re-query the same chat for every record.
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
					? // Composite index: userId + status + downloadedAt — gets most recently
						// *downloaded* items without in-memory filtering.
						await ctx.db
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
							// Pending/downloading: oldest first (matches download order).
							// Failed: newest first.
							.order(
								status === "Pending" || status === "Downloading"
									? "asc"
									: "desc",
							)
							.take(limit);

			for (const m of records) {
				// Look up the message timestamp from the messages table.
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

/** Cancel a pending or downloading media record (human-callable). */
export const cancelDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: result(v.null()),
	handler: async (ctx, { telegramFileId }) => {
		const caller = await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", telegramFileId))
			.unique();

		if (!existing) return ok(null);
		requireOwner(caller.id, existing.userId);

		if (existing.status !== "Pending" && existing.status !== "Downloading") {
			return ok(null);
		}

		await ctx.db.patch(existing._id, {
			status: "Skipped" as const,
			bytesDownloaded: undefined,
			error: undefined,
		});
		return ok(null);
	},
});

/** Request download for a skipped media record (human-callable). */
export const requestDownload = mutation({
	args: { telegramFileId: v.string() },
	returns: result(v.null()),
	handler: async (ctx, { telegramFileId }) => {
		const caller = await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", telegramFileId))
			.unique();

		if (!existing) return ok(null);
		requireOwner(caller.id, existing.userId);

		if (existing.status !== "Skipped") return ok(null);

		await ctx.db.patch(existing._id, {
			status: "Pending" as const,
		});
		return ok(null);
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
