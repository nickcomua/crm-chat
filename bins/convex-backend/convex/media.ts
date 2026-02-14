import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { mediaKind, mediaStatus } from "./schema";
import {
	isRobotCaller,
	requireAuth,
	requireHuman,
	requireOwner,
} from "./helpers/auth";

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
		externalId: v.string(),
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
		const caller = await requireAuth(ctx);
		if (!isRobotCaller(caller)) {
			throw new Error("Unauthorized: only robots can create media records");
		}

		// Check if media record already exists for this externalId
		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
			.unique();

		if (existing) {
			return null;
		}

		await ctx.db.insert("media", {
			...args,
			status: "pending" as const,
		});
		return null;
	},
});

/** Store media file after successful upload. Patches existing pending record. */
export const storeMedia = mutation({
	args: {
		externalId: v.string(),
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
		const caller = await requireAuth(ctx);
		if (!isRobotCaller(caller)) {
			throw new Error("Unauthorized: only robots can store media");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
			.unique();

		if (!existing) {
			// Record may have been deleted by purgeChatData — clean up orphaned storage
			await ctx.storage.delete(args.storageId);
			return null;
		}

		// Guard: if the user cancelled (skipped) while we were uploading, don't overwrite
		if (existing.status !== "downloading" && existing.status !== "pending") {
			await ctx.storage.delete(args.storageId);
			return null;
		}

		const { externalId: _, ...updates } = args;
		await ctx.db.patch(existing._id, {
			...updates,
			status: "stored" as const,
			storedAt: Date.now(),
		});
		return null;
	},
});

/** Mark a media record as failed. */
export const markFailed = mutation({
	args: {
		externalId: v.string(),
		error: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, { externalId, error }) => {
		const caller = await requireAuth(ctx);
		if (!isRobotCaller(caller)) {
			throw new Error("Unauthorized: only robots can mark media as failed");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.unique();

		if (!existing) {
			// Record may have been deleted by purgeChatData — nothing to mark
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "failed" as const,
			error,
		});
		return null;
	},
});

/** Reset a failed media record back to pending so the robot retries it. */
export const retryDownload = mutation({
	args: { externalId: v.string() },
	returns: v.null(),
	handler: async (ctx, { externalId }) => {
		await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.unique();

		if (!existing || existing.status !== "failed") {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "pending" as const,
			error: undefined,
			bytesDownloaded: undefined,
		});
		return null;
	},
});

/** Mark a media record as skipped (filtered by settings). */
export const markSkipped = mutation({
	args: {
		externalId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, { externalId }) => {
		const caller = await requireAuth(ctx);
		if (!isRobotCaller(caller)) {
			throw new Error("Unauthorized: only robots can skip media");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.unique();

		if (!existing) {
			throw new Error(`Media record not found: ${externalId}`);
		}

		await ctx.db.patch(existing._id, {
			status: "skipped" as const,
		});
		return null;
	},
});

/** Transition a media record to "downloading" status. Called at download start. */
export const startDownload = mutation({
	args: { externalId: v.string() },
	returns: v.null(),
	handler: async (ctx, { externalId }) => {
		const caller = await requireAuth(ctx);
		if (!isRobotCaller(caller)) {
			throw new Error("Unauthorized: only robots can start downloads");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.unique();

		if (!existing || existing.status !== "pending") {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "downloading" as const,
			bytesDownloaded: 0,
		});
		return null;
	},
});

/** Update download progress (bytes downloaded so far, and optionally total size). */
export const updateProgress = mutation({
	args: {
		externalId: v.string(),
		bytesDownloaded: v.number(),
		fileSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, { externalId, bytesDownloaded, fileSize }) => {
		const caller = await requireAuth(ctx);
		if (!isRobotCaller(caller)) {
			throw new Error("Unauthorized: only robots can update progress");
		}

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.unique();

		if (!existing || existing.status !== "downloading") {
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
			if (media.status === "stored" && media.storageId) {
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
			externalId: v.string(),
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
			if (media.status === "stored" && media.storageId) {
				const storageUrl = await ctx.storage.getUrl(media.storageId);
				url = storageUrl ?? undefined;
			}

			results.push({
				externalId: media.externalId,
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
 *  Includes "downloading" so interrupted downloads are retried on restart. */
export const listPendingForClient = query({
	args: { clientId: v.id("clients") },
	returns: v.array(
		v.object({
			externalId: v.string(),
			messageId: v.string(),
			chatId: v.string(),
			kind: mediaKind,
			fileSize: v.optional(v.number()),
		}),
	),
	handler: async (ctx, { clientId }) => {
		const caller = await requireAuth(ctx);
		if (!isRobotCaller(caller)) {
			throw new Error("Unauthorized: only robots can list pending media");
		}

		// Prioritize interrupted downloads, then pending. Batch to stay under
		// Convex's 8192 array-length return limit — the subscriber processes
		// these sequentially, so it will fetch the next batch on the next call.
		const downloading = await ctx.db
			.query("media")
			.withIndex("by_clientId_status", (q) =>
				q.eq("clientId", clientId).eq("status", "downloading"),
			)
			.take(200);

		const pending = await ctx.db
			.query("media")
			.withIndex("by_clientId_status", (q) =>
				q.eq("clientId", clientId).eq("status", "pending"),
			)
			.take(Math.max(0, 200 - downloading.length));

		return [...downloading, ...pending].map((m) => ({
			externalId: m.externalId,
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
			externalId: v.string(),
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
			const limit = status === "stored" ? 20 : status === "pending" ? 5 : 100;

			const records =
				status === "stored"
					? // Composite index: userId + status + storedAt — gets most recently
						// *downloaded* items without in-memory filtering.
						await ctx.db
							.query("media")
							.withIndex("by_userId_status_storedAt", (q) =>
								q.eq("userId", caller.id).eq("status", "stored"),
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
								status === "pending" || status === "downloading"
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
					externalId: m.externalId,
					messageId: m.messageId,
					kind: m.kind,
					status: m.status,
					bytesDownloaded: m.bytesDownloaded,
					fileSize: m.fileSize,
					fileName: m.fileName,
					mimeType: m.mimeType,
					chatId: m.chatId,
					chatName: await getChatName(m.chatId),
					messageTs: message?.ts,
					error: m.error,
					createdAt: m.storedAt ?? m._creationTime,
				});
			}
		}

		return results;
	},
});

/** Cancel a pending or downloading media record (human-callable). */
export const cancelDownload = mutation({
	args: { externalId: v.string() },
	returns: v.null(),
	handler: async (ctx, { externalId }) => {
		const caller = await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.unique();

		if (!existing) return null;
		requireOwner(caller.id, existing.userId);

		if (existing.status !== "pending" && existing.status !== "downloading") {
			return null;
		}

		await ctx.db.patch(existing._id, {
			status: "skipped" as const,
			bytesDownloaded: undefined,
			error: undefined,
		});
		return null;
	},
});

/** Request download for a skipped media record (human-callable). */
export const requestDownload = mutation({
	args: { externalId: v.string() },
	returns: v.null(),
	handler: async (ctx, { externalId }) => {
		const caller = await requireHuman(ctx);

		const existing = await ctx.db
			.query("media")
			.withIndex("by_externalId", (q) => q.eq("externalId", externalId))
			.unique();

		if (!existing) return null;
		requireOwner(caller.id, existing.userId);

		if (existing.status !== "skipped") return null;

		await ctx.db.patch(existing._id, {
			status: "pending" as const,
		});
		return null;
	},
});

/** Return media counts per status for a specific chat (for progress UI). */
export const countByStatusForChat = query({
	args: { chatId: v.string() },
	returns: v.object({
		pending: v.number(),
		downloading: v.number(),
		stored: v.number(),
		failed: v.number(),
		skipped: v.number(),
		total: v.number(),
	}),
	handler: async (ctx, { chatId }) => {
		await requireHuman(ctx);

		const allMedia = await ctx.db
			.query("media")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.collect();

		const counts = {
			pending: 0,
			downloading: 0,
			stored: 0,
			failed: 0,
			skipped: 0,
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
