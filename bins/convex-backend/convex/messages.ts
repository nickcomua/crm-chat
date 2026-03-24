import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { asyncMap } from "convex-helpers";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireHuman, requireOwner } from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { forwardedFromValidator, mediaKind, reactionValidator } from "./schema";

const MAX_CHAT_IDS = 100;

type MediaSettingsKey =
  | "savePhotos"
  | "saveVideos"
  | "saveAudio"
  | "saveVoice"
  | "saveStickers"
  | "saveDocuments"
  | "saveAnimations"
  | "saveVideoNotes";

const MEDIA_KIND_TO_SETTING: Record<string, MediaSettingsKey> = {
  Photo: "savePhotos",
  Video: "saveVideos",
  VideoNote: "saveVideoNotes",
  Audio: "saveAudio",
  Voice: "saveVoice",
  Sticker: "saveStickers",
  Animation: "saveAnimations",
  Document: "saveDocuments",
};

function mediaKindToSettingKey(kind: string): MediaSettingsKey | undefined {
  return MEDIA_KIND_TO_SETTING[kind];
}

/** Get the last message for each of the given chats (for chat-list previews). */
export const getLastPerChat = query({
  args: { chatIds: v.array(v.string()) },
  returns: v.array(
    v.object({
      chatId: v.string(),
      text: v.optional(v.string()),
      mediaExternalId: v.optional(v.string()),
      mediaKind: v.optional(mediaKind),
    })
  ),
  handler: async (ctx, { chatIds }) => {
    if (chatIds.length > MAX_CHAT_IDS) {
      return [];
    }
    const caller = await requireHuman(ctx);

    // Verify chat ownership and fetch last messages in parallel
    const entries = await asyncMap(chatIds, async (chatId) => {
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
        .unique();
      if (!chat || chat.userId !== caller.id) {
        return null;
      }

      const msg = await ctx.db
        .query("messages")
        .withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
        .order("desc")
        .first();
      if (!msg) {
        return null;
      }
      return {
        chatId,
        text: msg.text,
        mediaExternalId: msg.mediaExternalId,
        mediaKind: msg.mediaKind,
      };
    });
    return entries.filter((e): e is NonNullable<typeof e> => e !== null);
  },
});

/** List messages for a specific chat, paginated (newest first). */
export const listByChat = query({
  args: { chatId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { chatId, paginationOpts }) => {
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
      .withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
      .order("desc")
      .paginate(paginationOpts);
  },
});

/** Upsert a message. Human-only (workers use workerOps.upsertMessage).
 *  Auto-creates media records respecting per-chat/client media settings. */
export const upsert = mutation({
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
    replyToText: v.optional(v.string()),
    forwardedFrom: v.optional(forwardedFromValidator),
    reactions: v.optional(v.array(reactionValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await requireHuman(ctx);
    requireOwner(caller.id, args.userId);

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
        replyToMessageId: args.replyToMessageId,
        replyToText: args.replyToText,
        forwardedFrom: args.forwardedFrom,
        reactions: args.reactions,
      });
    } else {
      await ctx.db.insert("messages", args);
    }

    // Auto-create media record if this message has media.
    // Respects per-chat media settings (falling back to client-level settings).
    const { mediaExternalId: mid, mediaKind: mk } = args;
    if (mid && mk) {
      const existingMedia = await ctx.db
        .query("media")
        .withIndex("by_telegramFileId", (q) => q.eq("telegramFileId", mid))
        .unique();

      if (!existingMedia) {
        const chat = await ctx.db
          .query("chats")
          .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
          .unique();
        const client = await ctx.db.get(args.clientId);

        const settingKey = mediaKindToSettingKey(mk);
        let shouldSave = true;
        if (settingKey) {
          const chatVal = chat?.mediaSettings?.[settingKey];
          const clientVal = client?.mediaSettings?.[settingKey];
          if (chatVal !== undefined) {
            shouldSave = chatVal;
          } else if (clientVal !== undefined) {
            shouldSave = clientVal;
          }
        }

        await ctx.db.insert("media", {
          telegramFileId: mid,
          userId: args.userId,
          clientId: args.clientId,
          chatId: args.chatId,
          messageId: args.messageId,
          status: shouldSave ? ("Pending" as const) : ("Skipped" as const),
          kind: mk,
        });
      }
    }
    return null;
  },
});

/** Full-text search across messages owned by the caller. */
export const search = query({
  args: {
    query: v.string(),
    chatId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await requireHuman(ctx);
    const take = Math.min(args.limit ?? 20, 100);

    const results = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (s) => {
        const base = s.search("text", args.query).eq("userId", caller.id);
        if (args.chatId) {
          return base.eq("chatId", args.chatId);
        }
        return base;
      })
      .take(take);
    return results.map((msg) => ({
      _id: msg._id,
      messageId: msg.messageId,
      chatId: msg.chatId,
      text: msg.text,
      senderId: msg.senderId,
      timestamp: msg.timestamp,
      outgoing: msg.outgoing,
    }));
  },
});

/** Soft-delete a message by external ID. Human-only (workers use workerOps.markMessageDeleted). */
export const markDeleted = mutation({
  args: { externalId: v.string() },
  returns: result(
    v.null(),
    v.literal("Message not found or ambiguous (multiple matches)")
  ),
  handler: async (ctx, { externalId }) => {
    const caller = await requireHuman(ctx);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
      .collect();

    if (messages.length !== 1) {
      return err("Message not found or ambiguous (multiple matches)");
    }

    const msg = messages[0];
    requireOwner(caller.id, msg.userId);

    await ctx.db.patch(msg._id, { deleted: true });
    return ok(null);
  },
});
