import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { chatDoc, chatType } from "./schema";
import { isRobotCaller, requireAuth, requireHuman, requireOwner, requireRobot } from "./helpers/auth";

/** List scan-enabled chats for the current user, sorted by last message time (newest first). */
export const list = query({
  args: {},
  returns: v.array(chatDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_userId_lastMessageTs", (q) => q.eq("userId", caller.id))
      .order("desc")
      .collect();
    return chats.filter((c) => c.scanEnabled);
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
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();
    // Verify ownership — all chats for this client should belong to the caller
    return chats.filter((c) => c.userId === caller.id);
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

/** Toggle scanning for a specific chat. Human-only. */
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
    await ctx.db.patch(chat._id, { scanEnabled });
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
