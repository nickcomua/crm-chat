import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { mediaKind, mediaStatus } from "./schema";
import { isRobotCaller, requireAuth, requireHuman } from "./helpers/auth";

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

    const { externalId: _, ...updates } = args;
    await ctx.db.patch(existing._id, {
      ...updates,
      status: "stored" as const,
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

    if (!existing) {
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
      .take(200 - downloading.length);

    return [...downloading, ...pending].map((m) => ({
      externalId: m.externalId,
      messageId: m.messageId,
      chatId: m.chatId,
      kind: m.kind,
    }));
  },
});

/** List media records by status for the download manager UI. */
export const listByStatus = query({
  args: { statuses: v.array(mediaStatus) },
  returns: v.array(
    v.object({
      externalId: v.string(),
      kind: mediaKind,
      status: mediaStatus,
      bytesDownloaded: v.optional(v.number()),
      fileSize: v.optional(v.number()),
      fileName: v.optional(v.string()),
      mimeType: v.optional(v.string()),
      chatId: v.string(),
      error: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { statuses }) => {
    const caller = await requireHuman(ctx);

    const results = [];
    for (const status of statuses) {
      const limit = status === "stored" ? 20 : 100;
      const records = await ctx.db
        .query("media")
        .withIndex("by_userId_status", (q) =>
          q.eq("userId", caller.id).eq("status", status),
        )
        .order("desc")
        .take(limit);

      for (const m of records) {
        results.push({
          externalId: m.externalId,
          kind: m.kind,
          status: m.status,
          bytesDownloaded: m.bytesDownloaded,
          fileSize: m.fileSize,
          fileName: m.fileName,
          mimeType: m.mimeType,
          chatId: m.chatId,
          error: m.error,
          createdAt: m._creationTime,
        });
      }
    }

    return results;
  },
});
