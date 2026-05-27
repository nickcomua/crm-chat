/**
 * contactPins — CRM-level pinned interactions for a contact.
 *
 * DISCLAIMER: `contactPins` is a CRM-layer concept. It is UNRELATED to
 * Telegram's native pinned messages, to `chats.isPinned`, and to
 * `chats.pinnedName` (which is a user-overridable display name, not a pin).
 *
 * Snapshots: each pin copies `text`, `timestamp`, `senderId`, `outgoing`,
 * `mediaKind`, `mediaExternalId`, and the chat's current display name at pin
 * time. This guarantees pins survive hard-delete cascades triggered by
 * `updateScanEnabled(false)` in `chats.ts` — the pinned-messages UI never
 * needs to read the `messages` table to render a pin.
 *
 * The `isOrphaned` flag is derived at query time only for the navigation
 * affordance ("original no longer available"). The snapshot itself is the
 * source of truth for rendering.
 */

import { defineTable, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { humanMutation, humanQuery } from "../functions";
import { err, ok, result } from "../helpers/result";
import { contactPinSnapshotValidator } from "../helpers/validators";

// =============================================================================
// Table definition
// =============================================================================

const contactPinFields = v.object({
	userId: v.string(),
	contactId: v.id("contacts"),
	/** Original app-level message id. Used for navigation back to the live
	 *  message. May become dangling if the source is hard-deleted. */
	messageId: v.string(),
	/** Original chat the message was pinned from. */
	chatId: v.string(),
	/** Everything needed to render without touching the messages table. */
	snapshot: contactPinSnapshotValidator,
	/** Short user-provided comment on the pin. */
	note: v.optional(v.string()),
	pinnedAt: v.number(),
	pinnedByUserId: v.string(),
});

export const contactPinDoc = contactPinFields.extend({
	_id: v.id("contactPins"),
	_creationTime: v.number(),
});

export const contactPinsTable = defineTable(contactPinFields)
	.index("by_contactId_pinnedAt", ["contactId", "pinnedAt"])
	.index("by_userId", ["userId"])
	.index("by_messageId_contactId", ["messageId", "contactId"]);

// =============================================================================
// Mutations / queries
// =============================================================================

/** Pin a message to a contact. Idempotent — if a pin already exists for
 *  `(contactId, messageId)`, returns it unchanged. */
export const pinMessage = humanMutation({
	args: {
		contactId: v.id("contacts"),
		messageId: v.string(),
		note: v.optional(v.string()),
	},
	returns: result(
		v.object({ pinId: v.id("contactPins") }),
		v.union(v.literal("Contact not found"), v.literal("Message not found")),
	),
	handler: async (ctx, { contactId, messageId, note }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return err("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		// Idempotency: return existing pin if one already exists.
		const existing = await ctx.db
			.query("contactPins")
			.withIndex("by_messageId_contactId", (q) =>
				q.eq("messageId", messageId).eq("contactId", contactId),
			)
			.unique();
		if (existing) {
			return ok({ pinId: existing._id });
		}

		const message = await ctx.db
			.query("messages")
			.withIndex("by_messageId", (q) => q.eq("messageId", messageId))
			.unique();
		if (!message) {
			return err("Message not found");
		}
		if (message.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		const chat = await ctx.db
			.query("chats")
			.withIndex("by_chatId", (q) => q.eq("chatId", message.chatId))
			.unique();

		const chatDisplayNameAtPinTime = chat?.pinnedName;

		const pinId = await ctx.db.insert("contactPins", {
			userId: ctx.caller.tokenIdentifier,
			contactId,
			messageId: message.messageId,
			chatId: message.chatId,
			snapshot: {
				text: message.text,
				timestamp: message.timestamp,
				senderId: message.senderId,
				outgoing: message.outgoing,
				mediaKind: message.mediaKind,
				mediaExternalId: message.mediaExternalId,
				chatDisplayNameAtPinTime,
			},
			note,
			pinnedAt: Date.now(),
			pinnedByUserId: ctx.caller.tokenIdentifier,
		});

		return ok({ pinId });
	},
});

/** Remove a pin. No-op if the pin does not exist. */
export const unpinMessage = humanMutation({
	args: { contactId: v.id("contacts"), messageId: v.string() },
	returns: result(v.null(), v.literal("Contact not found")),
	handler: async (ctx, { contactId, messageId }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return err("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		const existing = await ctx.db
			.query("contactPins")
			.withIndex("by_messageId_contactId", (q) =>
				q.eq("messageId", messageId).eq("contactId", contactId),
			)
			.unique();
		if (existing) {
			await ctx.db.delete(existing._id);
		}
		return ok(null);
	},
});

/** Paginated list of pins for a contact, desc by `pinnedAt`.
 *  Returns each pin with a derived `isOrphaned` flag set when the original
 *  `messages` row no longer exists. Snapshots are inline so the UI can
 *  render pins even for hard-deleted messages. */
export const listForContact = humanQuery({
	args: {
		contactId: v.id("contacts"),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, { contactId, paginationOpts }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			throw new Error("Contact not found");
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		const pageResult = await ctx.db
			.query("contactPins")
			.withIndex("by_contactId_pinnedAt", (q) => q.eq("contactId", contactId))
			.order("desc")
			.paginate(paginationOpts);

		// Derive isOrphaned for each pin.
		const enrichedPage = [];
		for (const pin of pageResult.page) {
			const msg = await ctx.db
				.query("messages")
				.withIndex("by_messageId", (q) => q.eq("messageId", pin.messageId))
				.unique();
			enrichedPage.push({
				...pin,
				isOrphaned: msg === null,
			});
		}

		return { ...pageResult, page: enrichedPage };
	},
});

/** Return the set of pinned messageIds for a contact. The frontend builds
 *  a `Set` once per contact and uses it for per-bubble pin indicators. */
export const listPinnedMessageIdsForContact = humanQuery({
	args: { contactId: v.id("contacts") },
	returns: v.array(v.string()),
	handler: async (ctx, { contactId }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return [];
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		const pins = await ctx.db
			.query("contactPins")
			.withIndex("by_contactId_pinnedAt", (q) => q.eq("contactId", contactId))
			.collect();
		return pins.map((p) => p.messageId);
	},
});
