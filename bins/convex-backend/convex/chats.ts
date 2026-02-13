import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { chatDoc, chatListItem, chatType, mediaSettingsValidator, scanPhase } from "./schema";
import { isRobotCaller, requireAuth, requireHuman, requireOwner, requireRobot } from "./helpers/auth";

/** List scan-enabled chats for the current user, sorted by last message time (newest first). */
export const list = query({
  args: {},
  returns: v.array(chatListItem),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_userId_scanEnabled_lastMessageTs", (q) =>
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

/** Upsert a chat. Callable by owner or robot. */
export const upsert = mutation({
  args: {
    chatId: v.string(),
    userId: v.string(),
    clientId: v.id("clients"),
    chatType,
    isPinned: v.boolean(),
    pinnedName: v.optional(v.string()),
    lastMessageTs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await requireAuth(ctx);

    // Authorization: owner or robot
    const isRobot = isRobotCaller(caller);
    if (!isRobot) {
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
        lastMessageTs: args.lastMessageTs,
      });
    } else {
      // Default scanEnabled to isPinned on first sync
      await ctx.db.insert("chats", {
        ...args,
        scanEnabled: args.isPinned,
      });
    }
  },
});

/** Delete a chat by its chatId. */
export const deleteChat = mutation({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const caller = await requireAuth(ctx);

    const existing = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();

    if (existing) {
      // Only owner or robot can delete
      const isRobot = isRobotCaller(caller);
      if (!isRobot) {
        requireOwner(caller.id, existing.userId);
      }
      await ctx.db.delete(existing._id);
    }
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
  returns: v.null(),
  handler: async (ctx, { chatId, pinnedName }) => {
    const caller = await requireHuman(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) throw new Error("Chat not found");
    requireOwner(caller.id, chat.userId);
    await ctx.db.patch(chat._id, { pinnedName });
  },
});

/** Toggle scanning for a specific chat. Human-only.
 *  Turning OFF resets fullScanned and schedules data purge (messages + media).
 *  Turning ON triggers a fresh rescan since fullScanned is already false. */
export const updateScanEnabled = mutation({
  args: { chatId: v.string(), scanEnabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { chatId, scanEnabled }) => {
    const caller = await requireHuman(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) throw new Error("Chat not found");
    requireOwner(caller.id, chat.userId);
    if (!scanEnabled) {
      await ctx.db.patch(chat._id, { scanEnabled, fullScanned: false });
      await ctx.scheduler.runAfter(0, internal.chats.purgeChatData, { chatId });
    } else {
      await ctx.db.patch(chat._id, { scanEnabled });
    }
  },
});

/** Mark a chat as fully scanned (all messages synced once). Robot-only. */
export const markFullScanned = mutation({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    await requireRobot(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) throw new Error("Chat not found");
    await ctx.db.patch(chat._id, { fullScanned: true });
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
      .withIndex("by_chatId_ts", (q) => q.eq("chatId", chatId))
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

/** List chats for a client. Robot-only (for scanning logic). */
export const listForRobot = query({
  args: { clientId: v.id("clients") },
  returns: v.array(chatDoc),
  handler: async (ctx, { clientId }) => {
    await requireRobot(ctx);
    return await ctx.db
      .query("chats")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
  },
});

/** Update per-chat media download settings. Human-only. */
export const updateMediaSettings = mutation({
  args: { chatId: v.string(), mediaSettings: mediaSettingsValidator },
  returns: v.null(),
  handler: async (ctx, { chatId, mediaSettings }) => {
    const caller = await requireHuman(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) throw new Error("Chat not found");
    requireOwner(caller.id, chat.userId);
    await ctx.db.patch(chat._id, { mediaSettings });
  },
});

/** Update sync progress for a chat. Robot-only. */
export const updateSyncProgress = mutation({
  args: {
    chatId: v.string(),
    totalMessages: v.optional(v.number()),
    syncedMessages: v.optional(v.number()),
    scanPhase: v.optional(scanPhase),
  },
  returns: v.null(),
  handler: async (ctx, { chatId, ...updates }) => {
    await requireRobot(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) throw new Error("Chat not found");

    const patch: Record<string, unknown> = {};
    if (updates.totalMessages !== undefined) patch.totalMessages = updates.totalMessages;
    if (updates.syncedMessages !== undefined) patch.syncedMessages = updates.syncedMessages;
    if (updates.scanPhase !== undefined) patch.scanPhase = updates.scanPhase;

    await ctx.db.patch(chat._id, patch);
  },
});

/** Re-scan all messages for a chat without purging data. Human-only.
 *  Resets fullScanned so the robot picks it up on the next refresh cycle. */
export const rescan = mutation({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const caller = await requireHuman(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) throw new Error("Chat not found");
    requireOwner(caller.id, chat.userId);
    if (!chat.scanEnabled) throw new Error("Chat scanning is not enabled");
    await ctx.db.patch(chat._id, {
      fullScanned: false,
      syncedMessages: undefined,
      totalMessages: undefined,
      scanPhase: undefined,
    });
  },
});

/** Update a chat's profile photo. Robot-only. */
export const updatePhoto = mutation({
  args: {
    chatId: v.string(),
    storageId: v.id("_storage"),
    photoExternalId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { chatId, storageId, photoExternalId }) => {
    await requireRobot(ctx);
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) throw new Error("Chat not found");
    if (chat.photoStorageId) {
      await ctx.storage.delete(chat.photoStorageId);
    }
    await ctx.db.patch(chat._id, { photoStorageId: storageId, photoExternalId });
  },
});
