import { defineTable } from "convex/server";
import { v } from "convex/values";
import { asyncMap } from "convex-helpers";
import {
  humanMutation,
  humanQuery,
  workerMutation,
  workerQuery,
} from "../functions";
import { err, ok, result } from "../helpers/result";
import { mediaSettingsValidator, workItem } from "../helpers/validators";

// =============================================================================
// Table-specific validators
// =============================================================================

export const chatType = v.union(v.literal("Dialog"), v.literal("Group"));

export const scanPhase = v.union(
  v.literal("Queued"),
  v.literal("ScanningMessages"),
  v.literal("DownloadingMedia"),
  v.literal("Listening")
);

const chatFields = v.object({
  chatId: v.string(),
  userId: v.string(),
  clientId: v.id("clients"),
  chatType,
  isPinned: v.boolean(),
  pinnedName: v.optional(v.string()),
  lastMessageTimestamp: v.number(),
  scanEnabled: v.optional(v.boolean()),
  fullScanned: v.optional(v.boolean()),
  mediaSettings: v.optional(mediaSettingsValidator),
  totalMessages: v.optional(v.number()),
  syncedMessages: v.optional(v.number()),
  scanPhase: v.optional(scanPhase),
  photoStorageId: v.optional(v.id("_storage")),
  photoExternalId: v.optional(v.string()),
});

export const chatDoc = chatFields.extend({
  _id: v.id("chats"),
  _creationTime: v.number(),
});

/** chatDoc fields + resolved photoUrl for the frontend chat list. */
export const chatListItem = chatDoc.extend({
  photoUrl: v.optional(v.string()),
});

export const chatsTable = defineTable(chatFields)
  .index("by_chatId", ["chatId"])
  .index("by_userId", ["userId"])
  .index("by_clientId", ["clientId"])
  .index("by_userId_lastMessageTimestamp", ["userId", "lastMessageTimestamp"])
  .index("by_userId_scanEnabled_lastMessageTimestamp", [
    "userId",
    "scanEnabled",
    "lastMessageTimestamp",
  ])
  .index("by_clientId_userId", ["clientId", "userId"])
  .index("by_scanPhase", ["scanPhase"]);

/** List scan-enabled chats for the current user, sorted by last message time (newest first). */
export const list = humanQuery({
  args: {},
  returns: v.array(chatListItem),
  handler: async (ctx) => {
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_userId_scanEnabled_lastMessageTimestamp", (q) =>
        q.eq("userId", ctx.caller.tokenIdentifier).eq("scanEnabled", true)
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

/** Upsert a chat. Human-only (workers use workerUpsertChat). */
export const upsert = humanMutation({
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
    if (ctx.caller.tokenIdentifier !== args.userId) {
      throw new Error("Unauthorized: you do not own this resource");
    }

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
export const deleteChat = humanMutation({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const existing = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();

    if (existing) {
      if (existing.userId !== ctx.caller.tokenIdentifier) {
        throw new Error("Unauthorized: you do not own this resource");
      }
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

/** List chats for a specific client. Human-only. */
export const listByClient = humanQuery({
  args: { clientId: v.id("clients") },
  returns: v.array(chatDoc),
  handler: async (ctx, { clientId }) => {
    return await ctx.db
      .query("chats")
      .withIndex("by_clientId_userId", (q) =>
        q.eq("clientId", clientId).eq("userId", ctx.caller.tokenIdentifier)
      )
      .collect();
  },
});

/** Update a chat's custom display name. Human-only. */
export const updatePinnedName = humanMutation({
  args: { chatId: v.string(), pinnedName: v.optional(v.string()) },
  returns: result(v.null(), v.literal("Chat not found")),
  handler: async (ctx, { chatId, pinnedName }) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) {
      return err("Chat not found");
    }
    if (chat.userId !== ctx.caller.tokenIdentifier) {
      throw new Error("Unauthorized: you do not own this resource");
    }
    await ctx.db.patch(chat._id, { pinnedName });
    return ok(null);
  },
});

/** Toggle scanning for a specific chat. Human-only.
 *  Turning OFF resets fullScanned and schedules data purge (messages + media).
 *  Turning ON sets scanPhase="Queued" — the reconciler dispatches ChatScanner. */
export const updateScanEnabled = humanMutation({
  args: { chatId: v.string(), scanEnabled: v.boolean() },
  returns: result(v.null(), v.literal("Chat not found")),
  handler: async (ctx, { chatId, scanEnabled }) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) {
      return err("Chat not found");
    }
    if (chat.userId !== ctx.caller.tokenIdentifier) {
      throw new Error("Unauthorized: you do not own this resource");
    }
    if (scanEnabled) {
      // Reset fullScanned + set scanPhase=Queued so the reconciler dispatches a scan.
      await ctx.db.patch(chat._id, {
        scanEnabled,
        fullScanned: false,
        scanPhase: "Queued" as const,
      });
    } else {
      await ctx.db.patch(chat._id, {
        scanEnabled,
        fullScanned: false,
        scanPhase: undefined,
      });

      // Purge all messages for this chat
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
        .collect();
      for (const msg of messages) {
        await ctx.db.delete(msg._id);
      }

      // Purge all media for this chat (also clean up storage files)
      const mediaRecords = await ctx.db
        .query("media")
        .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
        .collect();
      for (const media of mediaRecords) {
        if (media.storageId) {
          await ctx.storage.delete(media.storageId);
        }
        await ctx.db.delete(media._id);
      }
    }
    return ok(null);
  },
});

/** Return chatIds of scan-enabled chats for a client. Worker-only. */
export const scanEnabledChatIds = workerQuery({
  args: { clientId: v.id("clients") },
  returns: v.array(v.string()),
  handler: async (ctx, { clientId }) => {
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
    return chats.filter((c) => c.scanEnabled).map((c) => c.chatId);
  },
});

/** Update per-chat media download settings. Human-only. */
export const updateMediaSettings = humanMutation({
  args: { chatId: v.string(), mediaSettings: mediaSettingsValidator },
  returns: result(v.null(), v.literal("Chat not found")),
  handler: async (ctx, { chatId, mediaSettings }) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) {
      return err("Chat not found");
    }
    if (chat.userId !== ctx.caller.tokenIdentifier) {
      throw new Error("Unauthorized: you do not own this resource");
    }
    await ctx.db.patch(chat._id, { mediaSettings });
    return ok(null);
  },
});

/** Re-scan all messages for a chat without purging data. Human-only.
 *  Sets scanPhase=Queued — the reconciler dispatches ChatScanner. */
export const rescan = humanMutation({
  args: { chatId: v.string() },
  returns: result(
    v.null(),
    v.union(
      v.literal("Chat not found"),
      v.literal("Chat scanning is not enabled")
    )
  ),
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) {
      return err("Chat not found");
    }
    if (chat.userId !== ctx.caller.tokenIdentifier) {
      throw new Error("Unauthorized: you do not own this resource");
    }
    if (!chat.scanEnabled) {
      return err("Chat scanning is not enabled");
    }
    await ctx.db.patch(chat._id, {
      fullScanned: false,
      syncedMessages: undefined,
      totalMessages: undefined,
      scanPhase: "Queued" as const,
    });

    return ok(null);
  },
});

// =============================================================================
// Cancel-watcher query (for domain-driven dispatch)
// =============================================================================

/**
 * Lightweight scanPhase query for domain cancel-watcher.
 * Rust handler subscribes to this and cancels if scan is no longer active.
 */
export const getScanPhase = workerQuery({
  args: { chatId: v.id("chats") },
  returns: v.union(scanPhase, v.null()),
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId);
    return chat?.scanPhase ?? null;
  },
});

/** Get a single chat by _id. Worker-only. */
export const getForWorker = workerQuery({
  args: { chatId: v.id("chats") },
  returns: v.union(chatDoc, v.null()),
  handler: async (ctx, { chatId }) => {
    return await ctx.db.get(chatId);
  },
});

/** List all chats for a client (worker version for ProfilePhotoSync). Worker-only. */
export const listChatsForWorker = workerQuery({
  args: { clientId: v.id("clients") },
  returns: v.array(chatDoc),
  handler: async (ctx, { clientId }) => {
    return await ctx.db
      .query("chats")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
  },
});

// =============================================================================
// Domain lifecycle mutations (for domain-driven dispatch)
// =============================================================================

/** Transition chat Queued → ScanningMessages. Worker-only. */
export const workerStartScan = workerMutation({
  args: { chatId: v.id("chats") },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.scanPhase !== "Queued") {
      return null;
    }
    await ctx.db.patch(chatId, { scanPhase: "ScanningMessages" });
    return null;
  },
});

/** Complete chat scan: fullScanned=true, scanPhase=Listening. Worker-only. */
export const workerCompleteScan = workerMutation({
  args: { chatId: v.id("chats") },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId);
    if (!chat) {
      return null;
    }
    await ctx.db.patch(chatId, {
      fullScanned: true,
      scanPhase: "Listening",
    });
    return null;
  },
});

// =============================================================================
// Worker domain operations (moved from domainOps.ts)
// =============================================================================

/** Upsert a chat record. Worker-only. */
export const workerUpsertChat = workerMutation({
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

/** Update sync progress for a chat. Worker-only. */
export const workerUpdateSyncProgress = workerMutation({
  args: {
    chatId: v.string(),
    totalMessages: v.optional(v.number()),
    syncedMessages: v.optional(v.number()),
    scanPhase: v.optional(scanPhase),
    fullScanned: v.optional(v.boolean()),
  },
  returns: result(v.null(), v.literal("Chat not found")),
  handler: async (ctx, { chatId, ...updates }) => {
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

/** Update a chat's profile photo. Worker-only. */
export const workerUpdateChatPhoto = workerMutation({
  args: {
    chatId: v.string(),
    storageId: v.id("_storage"),
    photoExternalId: v.string(),
  },
  returns: result(v.null(), v.literal("Chat not found")),
  handler: async (ctx, { chatId, storageId, photoExternalId }) => {
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
// Pending work (for reconciler dispatch)
// =============================================================================

/** Chats queued for scanning. */
export const pendingWork = workerQuery({
  args: {},
  returns: v.array(workItem),
  handler: async (ctx) => {
    const queued = await ctx.db
      .query("chats")
      .withIndex("by_scanPhase", (q) => q.eq("scanPhase", "Queued"))
      .collect();
    return queued.map((c) => ({
      service: "ChatScanner",
      key: c._id,
      handler: "scan",
    }));
  },
});
