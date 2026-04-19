/**
 * Robot-only mutations for E2E test data seeding.
 * These bypass task validation and human-auth checks to allow
 * the test robot client to insert data directly.
 *
 * NEVER import these in production code.
 */
import { v } from "convex/values";
import { workerMutation, workerQuery } from "./functions";
import {
  contactPinSnapshotValidator,
  customFieldValidator,
  mediaKind,
  mediaStatus,
} from "./helpers/validators";
import { chatType } from "./model/chats";
import { forwardedFromValidator, reactionValidator } from "./model/messages";
import { messageSeverity } from "./model/notifications";

/** Insert a notification directly (no internal trigger needed). */
export const seedNotification = workerMutation({
  args: {
    userId: v.string(),
    severity: messageSeverity,
    message: v.string(),
  },
  returns: v.id("notifications"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      ...args,
      dismissed: false,
    });
  },
});

/**
 * Mark every notification for a user as dismissed. Used by the
 * "All caught up" empty-state e2e test to avoid racing the crm-worker,
 * which happily creates fresh Error notifications in the background
 * whenever it fails to reach Telegram during the test run.
 */
export const dismissAllNotifications = workerMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const notifs = await ctx.db
      .query("notifications")
      .withIndex("by_userId_dismissed", (q) =>
        q.eq("userId", userId).eq("dismissed", false)
      )
      .collect();
    for (const n of notifs) {
      await ctx.db.patch(n._id, { dismissed: true });
    }
    return null;
  },
});

/** Upsert a chat. Robot-accessible version of chats.upsert for test seeding. */
export const seedChat = workerMutation({
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
        scanEnabled: args.isPinned,
      });
    } else {
      await ctx.db.insert("chats", {
        ...args,
        scanEnabled: args.isPinned,
      });
    }
    return null;
  },
});

/** Insert a media record at any status, bypassing task validation. */
export const seedMediaRecord = workerMutation({
  args: {
    telegramFileId: v.string(),
    userId: v.string(),
    clientId: v.id("clients"),
    chatId: v.string(),
    messageId: v.string(),
    kind: mediaKind,
    status: mediaStatus,
    mimeType: v.optional(v.string()),
    fileName: v.optional(v.string()),
    fileSize: v.optional(v.number()),
    error: v.optional(v.string()),
    downloadedAt: v.optional(v.number()),
  },
  returns: v.id("media"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("media", args);
  },
});

/** Insert a message with optional reply/forward/reaction fields. */
export const seedMessage = workerMutation({
  args: {
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
    replyToMessageId: v.optional(v.string()),
    // Pass only to simulate a "Quote this part" reply. Plain replies should
    // leave this undefined — matches prod semantics where the worker only
    // fills replyToText from the Telegram reply header's quote_text.
    replyToText: v.optional(v.string()),
    forwardedFrom: v.optional(forwardedFromValidator),
    reactions: v.optional(v.array(reactionValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("messages", args);
    }
    return null;
  },
});

/** Delete a single client by ID. Robot-accessible version of clients.deleteClient. */
export const deleteClient = workerMutation({
  args: { clientId: v.id("clients") },
  returns: v.null(),
  handler: async (ctx, { clientId }) => {
    const client = await ctx.db.get(clientId);
    if (!client) {
      return null;
    }

    // Cancel phone auths
    const phoneAuths = await ctx.db
      .query("phoneAuths")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
    for (const auth of phoneAuths) {
      await ctx.db.delete(auth._id);
    }

    // Cancel QR auth sessions for this client
    const qrAuths = await ctx.db
      .query("qrAuths")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
    for (const auth of qrAuths) {
      await ctx.db.delete(auth._id);
    }

    // Delete chats for this client
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
    for (const c of chats) {
      await ctx.db.delete(c._id);
    }

    // Write tombstone so workerRegisterConnected won't resurrect this client
    await ctx.db.insert("deletedClients", {
      userId: client.userId,
      telegramId: client.telegramId,
      deletedAt: Date.now(),
    });

    await ctx.db.delete(clientId);
    return null;
  },
});

// =============================================================================
// Robot-accessible queries for test verification
// =============================================================================

/** List messages by chatId (no pagination, up to 200). Robot-accessible. */
export const queryMessages = workerQuery({
  args: { chatId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { chatId, limit }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(limit ?? 200);
  },
});

/** Get last message per chat. Robot-accessible version of messages.getLastPerChat. */
export const queryLastPerChat = workerQuery({
  args: { chatIds: v.array(v.string()) },
  handler: async (ctx, { chatIds }) => {
    const results: Array<{
      chatId: string;
      text?: string;
      mediaExternalId?: string;
      mediaKind?: string;
    }> = [];
    for (const chatId of chatIds) {
      const msg = await ctx.db
        .query("messages")
        .withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
        .order("desc")
        .first();
      if (msg) {
        results.push({
          chatId,
          text: msg.text,
          mediaExternalId: msg.mediaExternalId,
          mediaKind: msg.mediaKind,
        });
      }
    }
    return results;
  },
});

/** Get a single client by ID. Robot-accessible. */
export const queryClient = workerQuery({
  args: { clientId: v.id("clients") },
  handler: async (ctx, { clientId }) => {
    return await ctx.db.get(clientId);
  },
});

/** List chats for a user. Robot-accessible version of chats.list. */
export const queryChats = workerQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("chats")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

/** Count media records by status for a user. Robot-accessible. */
export const queryMediaCountByStatus = workerQuery({
  args: { userId: v.string(), statuses: v.array(mediaStatus) },
  handler: async (ctx, { userId, statuses }) => {
    const results: Record<string, number> = {};
    for (const status of statuses) {
      const records = await ctx.db
        .query("media")
        .withIndex("by_userId_status", (q) =>
          q.eq("userId", userId).eq("status", status)
        )
        .collect();
      results[status] = records.length;
    }
    return results;
  },
});

/** List media by status for a user. Robot-accessible. */
export const queryMediaByStatus = workerQuery({
  args: { userId: v.string(), statuses: v.array(mediaStatus) },
  handler: async (ctx, { userId, statuses }) => {
    const all = [];
    for (const status of statuses) {
      const records = await ctx.db
        .query("media")
        .withIndex("by_userId_status", (q) =>
          q.eq("userId", userId).eq("status", status)
        )
        .collect();
      all.push(...records);
    }
    return all;
  },
});

/** Retry a failed media download. Robot-accessible (no task enqueue). */
export const retryDownload = workerMutation({
  args: { telegramFileId: v.string() },
  returns: v.null(),
  handler: async (ctx, { telegramFileId }) => {
    const existing = await ctx.db
      .query("media")
      .withIndex("by_telegramFileId", (q) =>
        q.eq("telegramFileId", telegramFileId)
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

/** Cancel a pending media download. Robot-accessible. */
export const cancelDownload = workerMutation({
  args: { telegramFileId: v.string() },
  returns: v.null(),
  handler: async (ctx, { telegramFileId }) => {
    const existing = await ctx.db
      .query("media")
      .withIndex("by_telegramFileId", (q) =>
        q.eq("telegramFileId", telegramFileId)
      )
      .unique();
    if (!existing) {
      return null;
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

/** Delete all data for a user. For test cleanup / empty-state tests. */
export const deleteAllForUser = workerMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    // Delete notifications
    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const n of notifications) {
      await ctx.db.delete(n._id);
    }

    // Delete media
    const media = await ctx.db
      .query("media")
      .withIndex("by_userId_status", (q) => q.eq("userId", userId))
      .collect();
    for (const m of media) {
      await ctx.db.delete(m._id);
    }

    // Delete messages
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const m of messages) {
      await ctx.db.delete(m._id);
    }

    // Delete QR auth sessions
    const qrAuths = await ctx.db
      .query("qrAuths")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const qa of qrAuths) {
      await ctx.db.delete(qa._id);
    }

    // Delete chats
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const c of chats) {
      await ctx.db.delete(c._id);
    }

    // Delete clients
    const clients = await ctx.db
      .query("clients")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const c of clients) {
      await ctx.db.delete(c._id);
    }

    // Delete phone auths
    const phoneAuths = await ctx.db
      .query("phoneAuths")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const p of phoneAuths) {
      await ctx.db.delete(p._id);
    }

    return null;
  },
});

/** Full-text search messages via Convex search index. Robot-accessible for E2E tests. */
export const searchMessages = workerQuery({
  args: {
    searchText: v.string(),
    userId: v.string(),
    chatId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { searchText, userId, chatId, limit }) => {
    const take = Math.min(limit ?? 20, 100);

    const results = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (s) => {
        const base = s.search("text", searchText).eq("userId", userId);
        if (chatId) {
          return base.eq("chatId", chatId);
        }
        return base;
      })
      .take(take);

    return results.map((msg) => ({
      messageId: msg.messageId,
      chatId: msg.chatId,
      text: msg.text,
      senderId: msg.senderId,
      timestamp: msg.timestamp,
    }));
  },
});

// =============================================================================
// Contact domain seed helpers (Task 8)
// =============================================================================

function computeCustomFieldsBlob(
  fields: Array<{ key: string; value: string }>
): string {
  return fields.map((f) => `${f.key}:${f.value}`).join(" ");
}

/** Insert a contact with defaults for custom fields and timestamps. */
export const insertTestContact = workerMutation({
  args: {
    userId: v.string(),
    displayName: v.string(),
    notes: v.optional(v.string()),
    customFields: v.optional(v.array(customFieldValidator)),
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const fields = args.customFields ?? [];
    return await ctx.db.insert("contacts", {
      userId: args.userId,
      displayName: args.displayName,
      notes: args.notes,
      customFields: fields,
      customFieldsBlob: computeCustomFieldsBlob(fields),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Insert a chatContactLinks row linking a contact to a (chatId, senderId). */
export const insertTestChatContactLink = workerMutation({
  args: {
    userId: v.string(),
    chatId: v.string(),
    senderId: v.string(),
    contactId: v.id("contacts"),
  },
  returns: v.id("chatContactLinks"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("chatContactLinks", {
      userId: args.userId,
      chatId: args.chatId,
      senderId: args.senderId,
      contactId: args.contactId,
      createdAt: Date.now(),
    });
  },
});

/** Insert a contactPins row with an explicit snapshot. */
export const insertTestContactPin = workerMutation({
  args: {
    userId: v.string(),
    contactId: v.id("contacts"),
    messageId: v.string(),
    chatId: v.string(),
    snapshot: contactPinSnapshotValidator,
    note: v.optional(v.string()),
  },
  returns: v.id("contactPins"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("contactPins", {
      userId: args.userId,
      contactId: args.contactId,
      messageId: args.messageId,
      chatId: args.chatId,
      snapshot: args.snapshot,
      note: args.note,
      pinnedAt: Date.now(),
      pinnedByUserId: args.userId,
    });
  },
});

/** Query contacts for a user. Robot-accessible. */
export const queryContacts = workerQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("contacts")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

/** Query chatContactLinks for a contact. Robot-accessible. */
export const queryChatContactLinks = workerQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    return await ctx.db
      .query("chatContactLinks")
      .withIndex("by_contactId", (q) => q.eq("contactId", contactId))
      .collect();
  },
});

/** Query contactPins for a contact. Robot-accessible. */
export const queryContactPins = workerQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    return await ctx.db
      .query("contactPins")
      .withIndex("by_contactId_pinnedAt", (q) => q.eq("contactId", contactId))
      .collect();
  },
});
