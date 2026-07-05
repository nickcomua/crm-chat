/**
 * Contacts table — first-class CRM layer that sits above Telegram's
 * ingested chats/messages. A contact represents a real person and is linked
 * to one or more `(chatId, senderId)` tuples via the `chatContactLinks`
 * reverse-index table.
 *
 * Ownership: every contact is scoped to a single `userId` (Clerk tokenIdentifier).
 *
 * Linking: see `chatContactLinks.ts` for the reverse-index. A given
 * `(chatId, senderId)` pair belongs to at most one contact at a time.
 *
 * Pinning: see `contactPins.ts`. Pins are CRM-level snapshots and are
 * unrelated to Telegram's native pinned messages or `chats.isPinned`.
 *
 * Merged timeline: the `listMergedMessages` query interleaves messages from
 * all linked 1:1 Dialog chats (group chats excluded). See that function's
 * header comment for cursor format and reactivity semantics.
 */

import { defineTable, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { humanMutation, humanQuery } from "../functions";
import { err, ok, result } from "../helpers/result";
import {
	customFieldValidator,
	senderLinkValidator,
} from "../helpers/validators";

type AuthenticatedQueryCtx = QueryCtx & {
	readonly caller: {
		readonly tokenIdentifier: string;
	};
};

// =============================================================================
// Table definition
// =============================================================================

const contactFields = v.object({
	userId: v.string(),
	displayName: v.string(),
	notes: v.optional(v.string()),
	customFields: v.array(customFieldValidator),
	/** Derived "key1:value1 key2:value2" blob feeding the search index.
	 *  Recomputed server-side on every mutation that touches customFields. */
	customFieldsBlob: v.optional(v.string()),
	createdAt: v.number(),
	/** Metadata only — NOT used for list sort order. List sorts by derived
	 *  `lastInteractionAt` which is computed from linked chats at query time. */
	updatedAt: v.number(),
});

export const contactDoc = contactFields.extend({
	_id: v.id("contacts"),
	_creationTime: v.number(),
});

/** Enriched contact for the list view. */
export const contactListItem = contactDoc.extend({
	linkedChatCount: v.number(),
	linkedSenderCount: v.number(),
	lastInteractionAt: v.optional(v.number()),
	lastMessagePreview: v.optional(v.string()),
	lastMessageChatId: v.optional(v.string()),
	lastMessageChatDisplayName: v.optional(v.string()),
	isOnline: v.boolean(),
	latestPresenceStatus: v.optional(v.string()),
	latestPresenceObservedAt: v.optional(v.number()),
});

export const contactsTable = defineTable(contactFields)
	.index("by_userId", ["userId"])
	.index("by_userId_displayName", ["userId", "displayName"])
	// Search index over the derived blob. Filter by userId so a single
	// search query never leaks across users.
	.searchIndex("search_custom_fields", {
		searchField: "customFieldsBlob",
		filterFields: ["userId"],
		staged: false,
	});

// =============================================================================
// Helpers
// =============================================================================

function computeCustomFieldsBlob(
	fields: Array<{ key: string; value: string }>,
): string {
	return fields.map((f) => `${f.key}:${f.value}`).join(" ");
}

function getChatDisplayName(chat: {
	pinnedName?: string;
	chatId: string;
}): string {
	if (chat.pinnedName) {
		return chat.pinnedName;
	}
	return `Chat ${chat.chatId.slice(0, 8)}`;
}

async function getLatestPresenceForSenders(
	ctx: AuthenticatedQueryCtx,
	userId: string,
	senderIds: readonly string[],
): Promise<{
	isOnline: boolean;
	status?: string;
	observedAt?: number;
}> {
	let latest:
		| {
				status: string;
				observedAt: number;
				expiresAt?: number;
		  }
		| undefined;
	for (const senderId of senderIds) {
		const presence = await ctx.db
			.query("contactPresence")
			.withIndex("by_userId_senderId_observedAt", (q) =>
				q.eq("userId", userId).eq("senderId", senderId),
			)
			.order("desc")
			.first();
		if (!presence) {
			continue;
		}
		if (!latest || presence.observedAt > latest.observedAt) {
			latest = {
				status: presence.status,
				observedAt: presence.observedAt,
				expiresAt: presence.expiresAt,
			};
		}
	}
	return {
		isOnline:
			latest?.status === "online" &&
			(latest.expiresAt === undefined || latest.expiresAt > Date.now()),
		status: latest?.status,
		observedAt: latest?.observedAt,
	};
}

// =============================================================================
// CRUD + link management (humanQuery / humanMutation)
// =============================================================================

/** List contacts for the caller, enriched with linked-chat counts and
 *  a derived `lastInteractionAt`. Sorted desc by lastInteractionAt.
 *
 *  Performance note: this is O(N_contacts × N_avg_links) per call. Bounded
 *  by expected single-user scale (a few thousand contacts). A dedicated
 *  `by_userId_lastInteractionAt` index is listed in the companion plan as
 *  a future optimization. */
export const list = humanQuery({
	args: {},
	returns: v.array(contactListItem),
	handler: async (ctx) => {
		const contacts = await ctx.db
			.query("contacts")
			.withIndex("by_userId", (q) => q.eq("userId", ctx.caller.tokenIdentifier))
			.collect();

		const enriched = [];
		for (const contact of contacts) {
			const links = await ctx.db
				.query("chatContactLinks")
				.withIndex("by_contactId", (q) => q.eq("contactId", contact._id))
				.collect();

			const chatIds = new Set(links.map((l) => l.chatId));
			const senderIds = [...new Set(links.map((l) => l.senderId))];
			const latestPresence = await getLatestPresenceForSenders(
				ctx,
				ctx.caller.tokenIdentifier,
				senderIds,
			);
			let lastInteractionAt: number | undefined;
			let lastMessagePreview: string | undefined;
			let lastMessageChatId: string | undefined;
			let lastMessageChatDisplayName: string | undefined;

			for (const chatId of chatIds) {
				const chat = await ctx.db
					.query("chats")
					.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
					.unique();
				if (!chat) {
					continue;
				}
				if (
					lastInteractionAt === undefined ||
					chat.lastMessageTimestamp > lastInteractionAt
				) {
					lastInteractionAt = chat.lastMessageTimestamp;
					lastMessageChatId = chat.chatId;
					lastMessageChatDisplayName = getChatDisplayName(chat);
					// Fetch the newest message's text as the preview.
					const msg = await ctx.db
						.query("messages")
						.withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
						.order("desc")
						.first();
					lastMessagePreview = msg?.text;
				}
			}

			enriched.push({
				...contact,
				linkedChatCount: chatIds.size,
				linkedSenderCount: links.length,
				lastInteractionAt,
				lastMessagePreview,
				lastMessageChatId,
				lastMessageChatDisplayName,
				isOnline: latestPresence.isOnline,
				latestPresenceStatus: latestPresence.status,
				latestPresenceObservedAt: latestPresence.observedAt,
			});
		}

		// Sort desc by lastInteractionAt; undefined goes to the bottom.
		enriched.sort((a, b) => {
			const aTs = a.lastInteractionAt ?? 0;
			const bTs = b.lastInteractionAt ?? 0;
			return bTs - aTs;
		});

		return enriched;
	},
});

/** Fetch a single contact by id with its sender links. Owner-checked. */
export const get = humanQuery({
	args: { contactId: v.id("contacts") },
	returns: v.union(
		v.null(),
		v.object({
			contact: contactDoc,
			isOnline: v.boolean(),
			latestPresenceStatus: v.optional(v.string()),
			latestPresenceObservedAt: v.optional(v.number()),
			links: v.array(
				v.object({
					_id: v.id("chatContactLinks"),
					chatId: v.string(),
					senderId: v.string(),
					createdAt: v.number(),
				}),
			),
		}),
	),
	handler: async (ctx, { contactId }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return null;
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		const links = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_contactId", (q) => q.eq("contactId", contactId))
			.collect();
		const latestPresence = await getLatestPresenceForSenders(
			ctx,
			ctx.caller.tokenIdentifier,
			[...new Set(links.map((l) => l.senderId))],
		);
		return {
			contact,
			isOnline: latestPresence.isOnline,
			latestPresenceStatus: latestPresence.status,
			latestPresenceObservedAt: latestPresence.observedAt,
			links: links.map((l) => ({
				_id: l._id,
				chatId: l.chatId,
				senderId: l.senderId,
				createdAt: l.createdAt,
			})),
		};
	},
});

/** Search contacts by custom field blob. Uses the search index directly. */
export const searchByCustomFields = humanQuery({
	args: { query: v.string(), limit: v.optional(v.number()) },
	returns: v.array(contactDoc),
	handler: async (ctx, { query, limit }) => {
		const q = query.trim();
		if (q.length === 0) {
			return [];
		}
		const take = Math.min(limit ?? 20, 100);
		return await ctx.db
			.query("contacts")
			.withSearchIndex("search_custom_fields", (s) =>
				s
					.search("customFieldsBlob", q)
					.eq("userId", ctx.caller.tokenIdentifier),
			)
			.take(take);
	},
});

/** Create a new contact. Optionally attaches an initial sender link atomically. */
export const create = humanMutation({
	args: {
		displayName: v.string(),
		notes: v.optional(v.string()),
		customFields: v.optional(v.array(customFieldValidator)),
		initialLink: v.optional(senderLinkValidator),
		/** When true, any conflicting link on `initialLink` is reassigned to
		 *  this new contact instead of returning an error. */
		reassign: v.optional(v.boolean()),
	},
	returns: result(
		v.object({ contactId: v.id("contacts") }),
		v.literal("Sender already linked to another contact"),
	),
	handler: async (ctx, args) => {
		const now = Date.now();
		const customFields = args.customFields ?? [];
		const customFieldsBlob = computeCustomFieldsBlob(customFields);

		if (args.initialLink) {
			const initialLink = args.initialLink;
			// Verify the chat belongs to the caller before linking.
			const chat = await ctx.db
				.query("chats")
				.withIndex("by_chatId", (q) => q.eq("chatId", initialLink.chatId))
				.unique();
			if (!chat || chat.userId !== ctx.caller.tokenIdentifier) {
				throw new Error("Unauthorized: you do not own this resource");
			}

			const existing = await ctx.db
				.query("chatContactLinks")
				.withIndex("by_userId_chatId_senderId", (q) =>
					q
						.eq("userId", ctx.caller.tokenIdentifier)
						.eq("chatId", initialLink.chatId)
						.eq("senderId", initialLink.senderId),
				)
				.unique();

			if (existing && !args.reassign) {
				return err("Sender already linked to another contact");
			}

			const contactId = await ctx.db.insert("contacts", {
				userId: ctx.caller.tokenIdentifier,
				displayName: args.displayName,
				notes: args.notes,
				customFields,
				customFieldsBlob,
				createdAt: now,
				updatedAt: now,
			});

			if (existing) {
				await ctx.db.patch(existing._id, { contactId });
			} else {
				await ctx.db.insert("chatContactLinks", {
					userId: ctx.caller.tokenIdentifier,
					chatId: initialLink.chatId,
					senderId: initialLink.senderId,
					contactId,
					createdAt: now,
				});
			}

			return ok({ contactId });
		}

		const contactId = await ctx.db.insert("contacts", {
			userId: ctx.caller.tokenIdentifier,
			displayName: args.displayName,
			notes: args.notes,
			customFields,
			customFieldsBlob,
			createdAt: now,
			updatedAt: now,
		});

		return ok({ contactId });
	},
});

/** Update a contact's metadata. Recomputes customFieldsBlob when fields change. */
export const update = humanMutation({
	args: {
		contactId: v.id("contacts"),
		displayName: v.optional(v.string()),
		notes: v.optional(v.string()),
		customFields: v.optional(v.array(customFieldValidator)),
	},
	returns: result(v.null(), v.literal("Contact not found")),
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) {
			return err("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.displayName !== undefined) {
			patch.displayName = args.displayName;
		}
		if (args.notes !== undefined) {
			patch.notes = args.notes;
		}
		if (args.customFields !== undefined) {
			patch.customFields = args.customFields;
			patch.customFieldsBlob = computeCustomFieldsBlob(args.customFields);
		}
		await ctx.db.patch(args.contactId, patch);
		return ok(null);
	},
});

/** Delete a contact and cascade-delete its links and pins.
 *  Does NOT delete chats or messages. */
export const deleteContact = humanMutation({
	args: { contactId: v.id("contacts") },
	returns: result(v.null(), v.literal("Contact not found")),
	handler: async (ctx, { contactId }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return err("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		const links = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_contactId", (q) => q.eq("contactId", contactId))
			.collect();
		for (const l of links) {
			await ctx.db.delete(l._id);
		}

		const pins = await ctx.db
			.query("contactPins")
			.withIndex("by_contactId_pinnedAt", (q) => q.eq("contactId", contactId))
			.collect();
		for (const p of pins) {
			await ctx.db.delete(p._id);
		}

		await ctx.db.delete(contactId);
		return ok(null);
	},
});

/** Link a `(chatId, senderId)` pair to a contact. On conflict, either
 *  returns an error or atomically reassigns the link. */
export const linkSender = humanMutation({
	args: {
		contactId: v.id("contacts"),
		chatId: v.string(),
		senderId: v.string(),
		reassign: v.optional(v.boolean()),
	},
	returns: result(
		v.null(),
		v.union(
			v.literal("Contact not found"),
			v.literal("Chat not found"),
			v.literal("Sender already linked to another contact"),
		),
	),
	handler: async (ctx, { contactId, chatId, senderId, reassign }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return err("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

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

		const existing = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_userId_chatId_senderId", (q) =>
				q
					.eq("userId", ctx.caller.tokenIdentifier)
					.eq("chatId", chatId)
					.eq("senderId", senderId),
			)
			.unique();

		if (existing) {
			if (existing.contactId === contactId) {
				// Already linked, no-op.
				return ok(null);
			}
			if (!reassign) {
				return err("Sender already linked to another contact");
			}
			await ctx.db.patch(existing._id, { contactId });
		} else {
			await ctx.db.insert("chatContactLinks", {
				userId: ctx.caller.tokenIdentifier,
				chatId,
				senderId,
				contactId,
				createdAt: Date.now(),
			});
		}

		await ctx.db.patch(contactId, { updatedAt: Date.now() });
		return ok(null);
	},
});

/** Unlink a `(chatId, senderId)` pair. Does NOT delete pins. */
export const unlinkSender = humanMutation({
	args: {
		contactId: v.id("contacts"),
		chatId: v.string(),
		senderId: v.string(),
	},
	returns: result(v.null(), v.literal("Contact not found")),
	handler: async (ctx, { contactId, chatId, senderId }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return err("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		const existing = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_userId_chatId_senderId", (q) =>
				q
					.eq("userId", ctx.caller.tokenIdentifier)
					.eq("chatId", chatId)
					.eq("senderId", senderId),
			)
			.unique();

		if (existing && existing.contactId === contactId) {
			await ctx.db.delete(existing._id);
			await ctx.db.patch(contactId, { updatedAt: Date.now() });
		}
		return ok(null);
	},
});

/** Return every contact linked to the given chat. For Dialog chats this
 *  is at most one entry; for Group chats it can be several. */
export const getContactForChat = humanQuery({
	args: { chatId: v.string() },
	returns: v.array(
		v.object({
			contactId: v.id("contacts"),
			displayName: v.string(),
			senderId: v.string(),
		}),
	),
	handler: async (ctx, { chatId }) => {
		const links = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_userId_chatId", (q) =>
				q.eq("userId", ctx.caller.tokenIdentifier).eq("chatId", chatId),
			)
			.collect();
		const results = [];
		for (const l of links) {
			const c = await ctx.db.get(l.contactId);
			if (c) {
				results.push({
					contactId: l.contactId,
					displayName: c.displayName,
					senderId: l.senderId,
				});
			}
		}
		return results;
	},
});

/** Return every chat-contact link owned by the caller, joined with the
 *  contact's `displayName`. Used by `chat-list.tsx` to render a per-row
 *  "linked to contact" pill without an N+1 query. Reads use the existing
 *  `by_userId_chatId` index with a prefix-only equality on `userId`. */
export const listAllLinksForUser = humanQuery({
	args: {},
	returns: v.array(
		v.object({
			chatId: v.string(),
			contactId: v.id("contacts"),
			contactDisplayName: v.string(),
			senderId: v.string(),
		}),
	),
	handler: async (ctx) => {
		const links = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_userId_chatId", (q) =>
				q.eq("userId", ctx.caller.tokenIdentifier),
			)
			.collect();
		const results: Array<{
			chatId: string;
			contactId: Id<"contacts">;
			contactDisplayName: string;
			senderId: string;
		}> = [];
		for (const l of links) {
			const c = await ctx.db.get(l.contactId);
			if (c) {
				results.push({
					chatId: l.chatId,
					contactId: l.contactId,
					contactDisplayName: c.displayName,
					senderId: l.senderId,
				});
			}
		}
		return results;
	},
});

/** For Dialog chats, walk the first few messages and return the first
 *  incoming message's senderId. For Group chats, returns null (the UI must
 *  prompt the user to pick a sender). */
export const resolveDefaultSenderId = humanQuery({
	args: { chatId: v.string() },
	returns: v.union(v.null(), v.string()),
	handler: async (ctx, { chatId }) => {
		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
			.unique();
		if (!chat) {
			return null;
		}
		if (chat.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		if (chat.chatType !== "Dialog") {
			return null;
		}
		// Scan newest-first and return the first incoming sender.
		const messages = await ctx.db
			.query("messages")
			.withIndex("by_chatId_timestamp", (q) => q.eq("chatId", chatId))
			.order("desc")
			.take(50);
		for (const m of messages) {
			if (!m.outgoing) {
				return m.senderId;
			}
		}
		return null;
	},
});

// =============================================================================
// Task 5: mergeContacts
// =============================================================================

/** Merge two contacts. Moves all links, pins, custom fields, and notes
 *  from `sourceId` to `targetId`, then deletes the source contact.
 *
 *  Transactional: all operations happen inside a single mutation handler
 *  so Convex's serializable semantics guarantee atomicity. */
export const mergeContacts = humanMutation({
	args: {
		sourceId: v.id("contacts"),
		targetId: v.id("contacts"),
		conflictResolution: v.optional(
			v.union(
				v.literal("keepTarget"),
				v.literal("keepSource"),
				v.literal("keepBoth"),
			),
		),
	},
	returns: result(
		v.object({
			mergedContactId: v.id("contacts"),
			linksMoved: v.number(),
			pinsMoved: v.number(),
		}),
		v.union(
			v.literal("Source contact not found"),
			v.literal("Target contact not found"),
			v.literal("Cannot merge a contact into itself"),
			v.literal("Cannot merge contacts owned by different users"),
		),
	),
	handler: async (ctx, { sourceId, targetId, conflictResolution }) => {
		if (sourceId === targetId) {
			return err("Cannot merge a contact into itself");
		}
		const source = await ctx.db.get(sourceId);
		if (!source) {
			return err("Source contact not found");
		}
		const target = await ctx.db.get(targetId);
		if (!target) {
			return err("Target contact not found");
		}
		if (source.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		if (target.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		// Defensive: should be impossible given the auth checks above.
		if (source.userId !== target.userId) {
			return err("Cannot merge contacts owned by different users");
		}

		const resolution = conflictResolution ?? "keepBoth";

		// Move links. On conflict with an existing target link for the same
		// `(chatId, senderId)`, drop the source link (the target already owns it).
		const sourceLinks = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_contactId", (q) => q.eq("contactId", sourceId))
			.collect();
		let linksMoved = 0;
		for (const l of sourceLinks) {
			const conflict = await ctx.db
				.query("chatContactLinks")
				.withIndex("by_userId_chatId_senderId", (q) =>
					q
						.eq("userId", l.userId)
						.eq("chatId", l.chatId)
						.eq("senderId", l.senderId),
				)
				.unique();
			if (conflict && conflict.contactId === targetId) {
				await ctx.db.delete(l._id);
			} else {
				await ctx.db.patch(l._id, { contactId: targetId });
				linksMoved++;
			}
		}

		// Move pins. On conflict with the same (targetId, messageId), keep
		// the target's existing pin.
		const sourcePins = await ctx.db
			.query("contactPins")
			.withIndex("by_contactId_pinnedAt", (q) => q.eq("contactId", sourceId))
			.collect();
		let pinsMoved = 0;
		for (const p of sourcePins) {
			const existing = await ctx.db
				.query("contactPins")
				.withIndex("by_messageId_contactId", (q) =>
					q.eq("messageId", p.messageId).eq("contactId", targetId),
				)
				.unique();
			if (existing) {
				await ctx.db.delete(p._id);
			} else {
				await ctx.db.patch(p._id, { contactId: targetId });
				pinsMoved++;
			}
		}

		// Merge custom fields by strategy.
		let mergedFields = target.customFields;
		if (resolution === "keepSource") {
			mergedFields = source.customFields;
		} else if (resolution === "keepBoth") {
			mergedFields = [...target.customFields, ...source.customFields];
		}
		const mergedBlob = computeCustomFieldsBlob(mergedFields);

		// Concatenate notes.
		let mergedNotes = target.notes;
		if (source.notes && source.notes.trim().length > 0) {
			mergedNotes = target.notes
				? `${target.notes}\n---\n${source.notes}`
				: source.notes;
		}

		await ctx.db.patch(targetId, {
			customFields: mergedFields,
			customFieldsBlob: mergedBlob,
			notes: mergedNotes,
			updatedAt: Date.now(),
		});

		await ctx.db.delete(sourceId);

		return ok({ mergedContactId: targetId, linksMoved, pinsMoved });
	},
});

// =============================================================================
// Task 7: listMergedMessages
// =============================================================================

/**
 * Paginated merged-timeline query.
 *
 * Cursor format: `{ perChat: Record<chatId, { timestamp, messageId } | null> }`
 * serialized as a JSON string. `null` means "exhausted for this chat".
 * On first call (`cursor === null`), every chat starts at "newest".
 *
 * Tie-breaking: when two messages share a timestamp, the one with the
 * greater `messageId` sorts first (desc). The cursor keeps both fields so
 * resumption is exact.
 *
 * Reactivity: a new message inserted mid-pagination causes the first page
 * to include it on re-run, because the cursor only constrains older messages.
 *
 * Filters:
 *  - Excludes `Group` chats — only 1:1 Dialog chats participate in the merged view.
 *  - Filters per-chat messages to the senders linked via `chatContactLinks`.
 *
 * Degraded mode: if the contact has more than 40 linked chats, only the 40
 * most recently active ones are read, and `isDegraded: true` is returned so
 * the UI can surface a warning.
 *
 * Per-page budget: allocated as `max(numItems / linkedChatCount, 50)` per chat.
 * Linked-chat count is capped at 40. With numItems=1000 and 40 chats, each
 * chat reads ~50 messages per page — well under Convex's 4096-read cap
 * (see the comment in message-list.tsx around the multi-chat media pattern).
 */
const MERGED_CHAT_CAP = 40;
const MERGED_PER_CHAT_FLOOR = 50;

interface MergedCursor {
	perChat: Record<string, { timestamp: number; messageId: string } | null>;
}

function parseCursor(cursor: string | null): MergedCursor | null {
	if (!cursor) {
		return null;
	}
	try {
		return JSON.parse(cursor) as MergedCursor;
	} catch {
		return null;
	}
}

export const listMergedMessages = humanQuery({
	args: {
		contactId: v.id("contacts"),
		paginationOpts: paginationOptsValidator,
	},
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex message merging logic
	handler: async (ctx, { contactId, paginationOpts }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			throw new Error("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		// Collect links and group senders by chat.
		const links = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_contactId", (q) => q.eq("contactId", contactId))
			.collect();

		const sendersByChat = new Map<string, Set<string>>();
		for (const l of links) {
			let set = sendersByChat.get(l.chatId);
			if (!set) {
				set = new Set();
				sendersByChat.set(l.chatId, set);
			}
			set.add(l.senderId);
		}

		// Resolve chat metadata. Keep only Dialog chats.
		const chatMetaList: Array<{
			chatId: string;
			displayName: string;
			lastMessageTimestamp: number;
		}> = [];
		for (const chatId of sendersByChat.keys()) {
			const chat = await ctx.db
				.query("chats")
				.withIndex("by_chatId", (q) => q.eq("chatId", chatId))
				.unique();
			if (!chat) {
				continue;
			}
			if (chat.chatType !== "Dialog") {
				continue;
			}
			chatMetaList.push({
				chatId: chat.chatId,
				displayName: getChatDisplayName(chat),
				lastMessageTimestamp: chat.lastMessageTimestamp,
			});
		}

		// Degraded mode: cap to the 40 most recently active chats.
		let isDegraded = false;
		let activeChats = chatMetaList;
		if (chatMetaList.length > MERGED_CHAT_CAP) {
			isDegraded = true;
			activeChats = [...chatMetaList]
				.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp)
				.slice(0, MERGED_CHAT_CAP);
		}

		if (activeChats.length === 0) {
			return {
				page: [],
				isDone: true,
				continueCursor: JSON.stringify({ perChat: {} }),
				isDegraded,
			};
		}

		// Cursor handling.
		const numItems = paginationOpts.numItems;
		const perChatBudget = Math.max(
			MERGED_PER_CHAT_FLOOR,
			Math.ceil(numItems / activeChats.length),
		);
		const cursor = parseCursor(paginationOpts.cursor);

		// Pinned-messageId lookup for this contact (one read; cached per-page).
		const pins = await ctx.db
			.query("contactPins")
			.withIndex("by_contactId_pinnedAt", (q) => q.eq("contactId", contactId))
			.collect();
		const pinnedIds = new Set(pins.map((p) => p.messageId));

		// Collect candidate messages per chat.
		type MergedMsg = {
			_id: string;
			_creationTime: number;
			messageId: string;
			chatId: string;
			senderId: string;
			text?: string;
			outgoing: boolean;
			deleted: boolean;
			timestamp: number;
			mediaExternalId?: string;
			mediaKind?: string;
			replyToMessageId?: string;
			replyToText?: string;
			reactions?: Array<{
				emoji: string;
				count: number;
				recent: Array<{ userId: string }>;
			}>;
			forwardedFrom?: { senderName: string; date?: number };
			ttlPeriod?: number;
			ttlSeconds?: number;
			chatDisplayName: string;
			contactPinned: boolean;
		};

		const candidates: MergedMsg[] = [];
		const nextCursor: MergedCursor = { perChat: {} };

		for (const meta of activeChats) {
			const prev = cursor?.perChat[meta.chatId];
			if (prev === null) {
				// Already exhausted.
				nextCursor.perChat[meta.chatId] = null;
				continue;
			}
			let msgs = await ctx.db
				.query("messages")
				.withIndex("by_chatId_timestamp", (q) => q.eq("chatId", meta.chatId))
				.order("desc")
				.take(perChatBudget * 2); // over-fetch to allow sender filter

			if (prev) {
				msgs = msgs.filter(
					(m) =>
						m.timestamp < prev.timestamp ||
						(m.timestamp === prev.timestamp && m.messageId < prev.messageId),
				);
			}

			const senders = sendersByChat.get(meta.chatId) ?? new Set<string>();
			const filtered = msgs.filter((m) => senders.has(m.senderId));

			for (const m of filtered.slice(0, perChatBudget)) {
				candidates.push({
					_id: m._id,
					_creationTime: m._creationTime,
					messageId: m.messageId,
					chatId: m.chatId,
					senderId: m.senderId,
					text: m.text,
					outgoing: m.outgoing,
					deleted: m.deleted,
					timestamp: m.timestamp,
					mediaExternalId: m.mediaExternalId,
					mediaKind: m.mediaKind,
					replyToMessageId: m.replyToMessageId,
					replyToText: m.replyToText,
					reactions: m.reactions,
					forwardedFrom: m.forwardedFrom,
					ttlPeriod: m.ttlPeriod,
					ttlSeconds: m.ttlSeconds,
					chatDisplayName: meta.displayName,
					contactPinned: pinnedIds.has(m.messageId),
				});
			}
			if (filtered.length < perChatBudget) {
				nextCursor.perChat[meta.chatId] = null;
			} else {
				// Not exhausted — will advance cursor after merge below.
				nextCursor.perChat[meta.chatId] = prev ?? null;
			}
		}

		// Sort desc by (timestamp, messageId).
		candidates.sort((a, b) => {
			if (b.timestamp !== a.timestamp) {
				return b.timestamp - a.timestamp;
			}
			if (a.messageId < b.messageId) {
				return 1;
			}
			if (a.messageId > b.messageId) {
				return -1;
			}
			return 0;
		});

		const page = candidates.slice(0, numItems);

		// Advance per-chat cursor to the oldest message taken from each chat.
		for (const msg of page) {
			const cur = nextCursor.perChat[msg.chatId];
			// Only overwrite when we have an active (non-null) cursor slot for this chat.
			if (cur !== null) {
				// Track the minimum (timestamp, messageId) that we emitted.
				if (
					!cur ||
					msg.timestamp < cur.timestamp ||
					(msg.timestamp === cur.timestamp && msg.messageId < cur.messageId)
				) {
					nextCursor.perChat[msg.chatId] = {
						timestamp: msg.timestamp,
						messageId: msg.messageId,
					};
				}
			}
		}

		const isDone = Object.values(nextCursor.perChat).every((v) => v === null);

		// Resolve reply previews: `replyToText` is stored only for quote-replies;
		// for plain replies we fetch the parent message's text so the UI can
		// render a preview without extra round trips.
		const resolvedPage: typeof page = [];
		for (const msg of page) {
			if (msg.replyToText || !msg.replyToMessageId) {
				resolvedPage.push(msg);
				continue;
			}
			const parent = await ctx.db
				.query("messages")
				.withIndex("by_messageId", (q) =>
					q.eq("messageId", msg.replyToMessageId as string),
				)
				.unique();
			resolvedPage.push(
				parent?.text ? { ...msg, replyToText: parent.text } : msg,
			);
		}

		return {
			page: resolvedPage,
			isDone,
			continueCursor: JSON.stringify(nextCursor),
			isDegraded,
		};
	},
});
