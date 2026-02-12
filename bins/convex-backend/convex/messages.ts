import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { messageDoc } from "./schema";
import { isRobotCaller, requireAuth, requireHuman, requireOwner } from "./helpers/auth";

/** List all messages for the current user. */
export const list = query({
  args: {},
  returns: v.array(messageDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    return await ctx.db
      .query("messages")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .collect();
  },
});

/** List messages for a specific chat, ordered by timestamp. */
export const listByChat = query({
  args: { chatId: v.string() },
  returns: v.array(messageDoc),
  handler: async (ctx, { chatId }) => {
    const caller = await requireHuman(ctx);

    // Verify the caller owns this chat
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
      .unique();
    if (!chat) {
      throw new Error("Chat not found");
    }
    requireOwner(caller.id, chat.userId);

    return await ctx.db
      .query("messages")
      .withIndex("by_chatId_ts", (q) => q.eq("chatId", chatId))
      .order("asc")
      .collect();
  },
});

/** Upsert a message. Callable by owner or robot. */
export const upsert = mutation({
  args: {
    messageId: v.string(),
    externalId: v.string(),
    userId: v.string(),
    clientId: v.id("clients"),
    chatId: v.string(),
    senderId: v.string(),
    text: v.optional(v.string()),
    out: v.boolean(),
    deleted: v.boolean(),
    ts: v.number(),
    mediaId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await requireAuth(ctx);

    const isRobot = isRobotCaller(caller);
    if (!isRobot) {
      requireOwner(caller.id, args.userId);
    }

    const existing = await ctx.db
      .query("messages")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        text: args.text,
        out: args.out,
        deleted: args.deleted,
        ts: args.ts,
        mediaId: args.mediaId,
      });
    } else {
      await ctx.db.insert("messages", args);
    }
  },
});

/** Soft-delete a message by external ID. */
export const markDeleted = mutation({
  args: { externalId: v.string() },
  returns: v.null(),
  handler: async (ctx, { externalId }) => {
    const caller = await requireAuth(ctx);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
      .collect();

    if (messages.length !== 1) {
      throw new Error("Message not found or ambiguous (multiple matches)");
    }

    const msg = messages[0];
    const isRobot = isRobotCaller(caller);
    if (!isRobot) {
      requireOwner(caller.id, msg.userId);
    }

    await ctx.db.patch(msg._id, { deleted: true });
  },
});
