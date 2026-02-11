import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { chatDoc, chatType } from "./schema";
import { isRobotCaller, requireAuth, requireHuman, requireOwner } from "./helpers/auth";

/** List all chats for the current user, sorted by last message time (newest first). */
export const list = query({
  args: {},
  returns: v.array(chatDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    return await ctx.db
      .query("chats")
      .withIndex("by_userId_lastMessageTs", (q) => q.eq("userId", caller.id))
      .order("desc")
      .collect();
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
      await ctx.db.patch(existing._id, {
        chatType: args.chatType,
        isPinned: args.isPinned,
        pinnedName: args.pinnedName,
        lastMessageTs: args.lastMessageTs,
      });
    } else {
      await ctx.db.insert("chats", args);
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
