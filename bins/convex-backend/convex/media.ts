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
        width: media.width,
        height: media.height,
        duration: media.duration,
      });
    }

    return results;
  },
});

/** List pending media records for a client (for background download task). */
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

    const pending = await ctx.db
      .query("media")
      .withIndex("by_clientId_status", (q) =>
        q.eq("clientId", clientId).eq("status", "pending"),
      )
      .collect();

    return pending.map((m) => ({
      externalId: m.externalId,
      messageId: m.messageId,
      chatId: m.chatId,
      kind: m.kind,
    }));
  },
});
