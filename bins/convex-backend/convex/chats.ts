import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { chatDoc, chatListItem, chatType, mediaSettingsValidator, scanPhase } from "./schema";
import { isWorkerCaller, requireAuth, requireHuman, requireOwner, requireWorker } from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueTask } from "./helpers/tasks";

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

    return Promise.all(
      chats.map(async (chat) => {
        let photoUrl: string | undefined;
        if (chat.photoStorageId) {
          const url = await ctx.storage.getUrl(chat.photoStorageId);
          photoUrl = url ?? undefined;
        }
        return { ...chat, photoUrl };
      }),
    );
  },
});

/** Upsert a chat. Callable by owner or worker. */
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
  returns: result(v.null()),
  handler: async (ctx, args) => {
    const caller = await requireAuth(ctx);

    // Authorization: owner or worker
    const isWorker = isWorkerCaller(caller);
    if (!isWorker) {
      requireOwner(caller.id, args.userId);
    }

    const existing = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .unique();

    if (existing) {
      // Preserve user's scanEnabled override on update
      await ctx.db.patch(existing._id, {
        chatType: args.chatType,
        isPinned: args.isPinned,
        pinnedName: args.pinnedName,
        lastMessageTimestamp: args.lastMessageTimestamp,
      });
    } else {
      // Default scanEnabled to isPinned on first sync
      await ctx.db.insert("chats", {
        ...args,
        scanEnabled: args.isPinned,
      });
    }
    return ok(null);
  },
});

/** Delete a chat by its chatId. */
export const deleteChat = mutation({
  args: { chatId: v.string() },
  returns: result(v.null()),
  handler: async (ctx, { chatId }) => {
    const caller = await requireAuth(ctx);

    const existing = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();

    if (existing) {
      // Only owner or worker can delete
      const isWorker = isWorkerCaller(caller);
      if (!isWorker) {
        requireOwner(caller.id, existing.userId);
      }
      await ctx.db.delete(existing._id);
    }
    return ok(null);
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
  returns: result(v.null()),
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
  returns: result(v.null()),
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
      await ctx.db.patch(chat._id, { scanEnabled });
      // Enqueue scan if not already fully scanned
      if (!chat.fullScanned) {
        await enqueueTask(ctx, {
          type: "ChatScanner:scan",
          chatId,
          clientId: chat.clientId,
          userId: chat.userId,
        });
      }
    }
    return ok(null);
  },
});

/** Mark a chat as fully scanned (all messages synced once). Worker-only. */
export const markFullScanned = mutation({
  args: { chatId: v.string() },
  returns: result(v.null()),
  handler: async (ctx, { chatId }) => {
    await requireWorker(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) return err("Chat not found");
    await ctx.db.patch(chat._id, { fullScanned: true });
    return ok(null);
  },
});

const PURGE_BATCH_SIZE = 200;

/** Delete all messages and media for a chat in batches. Self-scheduling.
 *  Stops early if the chat has been re-enabled (to avoid racing with a new scan). */
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

/** List chats for a client. Worker-only (for scanning logic). */
export const listForWorker = query({
  args: { clientId: v.id("clients") },
  returns: v.array(chatDoc),
  handler: async (ctx, { clientId }) => {
    await requireWorker(ctx);
    return await ctx.db
      .query("chats")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
  },
});

/** Update per-chat media download settings. Human-only. */
export const updateMediaSettings = mutation({
  args: { chatId: v.string(), mediaSettings: mediaSettingsValidator },
  returns: result(v.null()),
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

/** Update sync progress for a chat. Worker-only. */
export const updateSyncProgress = mutation({
  args: {
    chatId: v.string(),
    totalMessages: v.optional(v.number()),
    syncedMessages: v.optional(v.number()),
    scanPhase: v.optional(scanPhase),
  },
  returns: result(v.null()),
  handler: async (ctx, { chatId, ...updates }) => {
    await requireWorker(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) return err("Chat not found");

    const patch: Record<string, unknown> = {};
    if (updates.totalMessages !== undefined) patch.totalMessages = updates.totalMessages;
    if (updates.syncedMessages !== undefined) patch.syncedMessages = updates.syncedMessages;
    if (updates.scanPhase !== undefined) patch.scanPhase = updates.scanPhase;

    await ctx.db.patch(chat._id, patch);
    return ok(null);
  },
});

/** Re-scan all messages for a chat without purging data. Human-only.
 *  Resets fullScanned so the worker picks it up on the next refresh cycle. */
export const rescan = mutation({
  args: { chatId: v.string() },
  returns: result(v.null()),
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
      syncedMessages: undefined,
      totalMessages: undefined,
      scanPhase: undefined,
    });

    // Enqueue scan task
    await enqueueTask(ctx, {
      type: "ChatScanner:scan",
      chatId,
      clientId: chat.clientId,
      userId: chat.userId,
    });

    return ok(null);
  },
});

/** Update a chat's profile photo. Worker-only. */
export const updatePhoto = mutation({
  args: {
    chatId: v.string(),
    storageId: v.id("_storage"),
    photoExternalId: v.string(),
  },
  returns: result(v.null()),
  handler: async (ctx, { chatId, storageId, photoExternalId }) => {
    await requireWorker(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) return err("Chat not found");
    if (chat.photoStorageId) {
      await ctx.storage.delete(chat.photoStorageId);
    }
    await ctx.db.patch(chat._id, { photoStorageId: storageId, photoExternalId });
    return ok(null);
  },
});
