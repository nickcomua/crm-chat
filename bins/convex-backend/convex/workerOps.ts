/**
 * Task-validated worker mutations.
 *
 * Every mutation takes `taskId` as its first arg and validates that the caller
 * is the assigned worker for a Running task. This ensures all worker writes
 * go through the task system.
 */
import { v } from "convex/values";
import { mutation } from "./functions";
import { requireRunningTask } from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueTask } from "./helpers/tasks";
import { chatType, mediaKind, scanPhase } from "./schema";

// =============================================================================
// Chat operations
// =============================================================================

/** Upsert a chat record. Task-validated worker mutation. */
export const upsertChat = mutation({
  args: {
    taskId: v.id("workerTasks"),
    chatId: v.string(),
    userId: v.string(),
    clientId: v.id("clients"),
    chatType,
    isPinned: v.boolean(),
    pinnedName: v.optional(v.string()),
    lastMessageTimestamp: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { taskId, ...args }) => {
    await requireRunningTask(ctx, taskId);

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

/** Update sync progress for a chat. Task-validated worker mutation. */
export const updateSyncProgress = mutation({
  args: {
    taskId: v.id("workerTasks"),
    chatId: v.string(),
    totalMessages: v.optional(v.number()),
    syncedMessages: v.optional(v.number()),
    scanPhase: v.optional(scanPhase),
    fullScanned: v.optional(v.boolean()),
  },
  returns: result(v.null(), v.literal("Chat not found")),
  handler: async (ctx, { taskId, chatId, ...updates }) => {
    await requireRunningTask(ctx, taskId);

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) {
      return err("Chat not found");
    }

    const patch: Record<string, unknown> = {};
    if (updates.totalMessages !== undefined) {
      patch.totalMessages = updates.totalMessages;
    }
    if (updates.syncedMessages !== undefined) {
      patch.syncedMessages = updates.syncedMessages;
    }
    if (updates.scanPhase !== undefined) {
      patch.scanPhase = updates.scanPhase;
    }
    if (updates.fullScanned !== undefined) {
      patch.fullScanned = updates.fullScanned;
    }

    await ctx.db.patch(chat._id, patch);
    return ok(null);
  },
});

/** Update a chat's profile photo. Task-validated worker mutation. */
export const updateChatPhoto = mutation({
  args: {
    taskId: v.id("workerTasks"),
    chatId: v.string(),
    storageId: v.id("_storage"),
    photoExternalId: v.string(),
  },
  returns: result(v.null(), v.literal("Chat not found")),
  handler: async (ctx, { taskId, chatId, storageId, photoExternalId }) => {
    await requireRunningTask(ctx, taskId);

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) {
      return err("Chat not found");
    }

    if (chat.photoStorageId) {
      await ctx.storage.delete(chat.photoStorageId);
    }
    await ctx.db.patch(chat._id, {
      photoStorageId: storageId,
      photoExternalId,
    });
    return ok(null);
  },
});

// =============================================================================
// Message operations
// =============================================================================

/** Upsert a message. Task-validated worker mutation.
 *  Unlike the human version, does NOT auto-create media records —
 *  the worker calls createPendingMedia explicitly. */
export const upsertMessage = mutation({
  args: {
    taskId: v.id("workerTasks"),
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
  },
  returns: v.null(),
  handler: async (ctx, { taskId, ...args }) => {
    await requireRunningTask(ctx, taskId);

    const existing = await ctx.db
      .query("messages")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        text: args.text,
        outgoing: args.outgoing,
        deleted: args.deleted,
        timestamp: args.timestamp,
        mediaExternalId: args.mediaExternalId,
        mediaKind: args.mediaKind,
      });
    } else {
      await ctx.db.insert("messages", args);
    }
    return null;
  },
});

/** Soft-delete a message by external ID. Task-validated worker mutation. */
export const markMessageDeleted = mutation({
  args: {
    taskId: v.id("workerTasks"),
    externalId: v.string(),
  },
  returns: result(
    v.null(),
    v.literal("Message not found or ambiguous (multiple matches)")
  ),
  handler: async (ctx, { taskId, externalId }) => {
    await requireRunningTask(ctx, taskId);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
      .collect();

    if (messages.length !== 1) {
      return err("Message not found or ambiguous (multiple matches)");
    }

    await ctx.db.patch(messages[0]._id, { deleted: true });
    return ok(null);
  },
});

// =============================================================================
// Media operations
// =============================================================================

/** Create a pending media record with full metadata. Task-validated worker mutation.
 *  Also enqueues a MediaDownloader task for the file. */
export const createPendingMedia = mutation({
  args: {
    taskId: v.id("workerTasks"),
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
  handler: async (ctx, { taskId, ...args }) => {
    await requireRunningTask(ctx, taskId);

    const existing = await ctx.db
      .query("media")
      .withIndex("by_telegramFileId", (q) =>
        q.eq("telegramFileId", args.telegramFileId)
      )
      .unique();

    if (existing) {
      return null;
    }

    await ctx.db.insert("media", {
      ...args,
      status: "Pending" as const,
    });

    const client = await ctx.db.get(args.clientId);
    if (client) {
      await enqueueTask(ctx, {
        type: "MediaDownloader",
        telegramFileId: args.telegramFileId,
        userId: args.userId,
        clientId: args.clientId,
        telegramId: client.telegramId,
        chatId: args.chatId,
        kind: args.kind,
        mimeType: args.mimeType,
        fileSize: args.fileSize,
      });
    }

    return null;
  },
});

/** Transition a media record to "Downloading". Task-validated worker mutation. */
export const startMediaDownload = mutation({
  args: {
    taskId: v.id("workerTasks"),
    telegramFileId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { taskId, telegramFileId }) => {
    await requireRunningTask(ctx, taskId);

    const existing = await ctx.db
      .query("media")
      .withIndex("by_telegramFileId", (q) =>
        q.eq("telegramFileId", telegramFileId)
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

/** Update download progress. Task-validated worker mutation. */
export const updateMediaProgress = mutation({
  args: {
    taskId: v.id("workerTasks"),
    telegramFileId: v.string(),
    bytesDownloaded: v.number(),
    fileSize: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { taskId, telegramFileId, bytesDownloaded, fileSize }
  ) => {
    await requireRunningTask(ctx, taskId);

    const existing = await ctx.db
      .query("media")
      .withIndex("by_telegramFileId", (q) =>
        q.eq("telegramFileId", telegramFileId)
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

/** Store media file after successful upload. Task-validated worker mutation. */
export const storeMedia = mutation({
  args: {
    taskId: v.id("workerTasks"),
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
  handler: async (ctx, { taskId, ...args }) => {
    await requireRunningTask(ctx, taskId);

    const existing = await ctx.db
      .query("media")
      .withIndex("by_telegramFileId", (q) =>
        q.eq("telegramFileId", args.telegramFileId)
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

/** Mark a media record as failed. Task-validated worker mutation. */
export const markMediaFailed = mutation({
  args: {
    taskId: v.id("workerTasks"),
    telegramFileId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { taskId, telegramFileId, error: errorMsg }) => {
    await requireRunningTask(ctx, taskId);

    const existing = await ctx.db
      .query("media")
      .withIndex("by_telegramFileId", (q) =>
        q.eq("telegramFileId", telegramFileId)
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
