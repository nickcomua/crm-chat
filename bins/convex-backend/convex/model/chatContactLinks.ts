/**
 * chatContactLinks — reverse-index table for contact ↔ (chatId, senderId) links.
 *
 * This table replaces the v1 `contacts.linkedChatIds` denormalized array.
 * Forward lookups (list a contact's senders) go through `by_contactId`.
 * Reverse lookups ("which contact(s) does this chat touch?") go through
 * `by_userId_chatId`. Unique per-(chatId, senderId) reassignment uses
 * `by_userId_chatId_senderId`.
 *
 * Uniqueness: a given `(chatId, senderId)` pair belongs to at most one
 * contact at a time. The single-mutation `linkSender` / `create` /
 * `mergeContacts` handlers in `contacts.ts` enforce this invariant
 * transactionally.
 *
 * Ownership: every row carries `userId` so index reads are user-scoped
 * and never leak across users.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";

const chatContactLinkFields = v.object({
	userId: v.string(),
	chatId: v.string(),
	senderId: v.string(),
	contactId: v.id("contacts"),
	createdAt: v.number(),
});

export const chatContactLinksTable = defineTable(chatContactLinkFields)
	.index("by_userId_chatId", ["userId", "chatId"])
	.index("by_userId_chatId_senderId", ["userId", "chatId", "senderId"])
	.index("by_contactId", ["contactId"]);
