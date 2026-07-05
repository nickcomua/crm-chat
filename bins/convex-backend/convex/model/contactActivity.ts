import { v } from "convex/values";
import { humanQuery } from "../functions";

const DAY_MS = 24 * 60 * 60 * 1000;

const activityDay = v.object({
	day: v.string(),
	incomingMessages: v.number(),
	outgoingMessages: v.number(),
	onlineEvents: v.number(),
	approxOnlineMinutes: v.number(),
});

function dayKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

export const summaryForContact = humanQuery({
	args: { contactId: v.id("contacts"), days: v.optional(v.number()) },
	returns: v.object({
		days: v.array(activityDay),
		totalIncomingMessages: v.number(),
		totalOutgoingMessages: v.number(),
		totalOnlineEvents: v.number(),
	}),
	handler: async (ctx, { contactId, days }) => {
		const contact = await ctx.db.get(contactId);
		if (!contact) {
			return {
				days: [],
				totalIncomingMessages: 0,
				totalOutgoingMessages: 0,
				totalOnlineEvents: 0,
			};
		}
		if (contact.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		const windowDays = Math.min(days ?? 91, 366);
		const since = Date.now() - windowDays * DAY_MS;
		const buckets = new Map<
			string,
			{
				incomingMessages: number;
				outgoingMessages: number;
				onlineEvents: number;
				approxOnlineMinutes: number;
			}
		>();
		const getBucket = (day: string) => {
			const existing = buckets.get(day);
			if (existing) {
				return existing;
			}
			const created = {
				incomingMessages: 0,
				outgoingMessages: 0,
				onlineEvents: 0,
				approxOnlineMinutes: 0,
			};
			buckets.set(day, created);
			return created;
		};

		const links = await ctx.db
			.query("chatContactLinks")
			.withIndex("by_contactId", (q) => q.eq("contactId", contactId))
			.collect();
		const senderIds = [...new Set(links.map((link) => link.senderId))];

		for (const link of links) {
			const messages = await ctx.db
				.query("messages")
				.withIndex("by_chatId_timestamp", (q) => q.eq("chatId", link.chatId))
				.order("desc")
				.take(500);
			for (const message of messages) {
				if (message.timestamp < since) {
					continue;
				}
				if (message.senderId !== link.senderId && !message.outgoing) {
					continue;
				}
				const bucket = getBucket(dayKey(message.timestamp));
				if (message.outgoing) {
					bucket.outgoingMessages += 1;
				} else {
					bucket.incomingMessages += 1;
				}
			}
		}

		for (const senderId of senderIds) {
			const statuses = await ctx.db
				.query("contactPresence")
				.withIndex("by_userId_senderId_observedAt", (q) =>
					q.eq("userId", ctx.caller.tokenIdentifier).eq("senderId", senderId),
				)
				.order("desc")
				.take(500);
			for (const status of statuses) {
				if (status.observedAt < since || status.status !== "online") {
					continue;
				}
				const bucket = getBucket(dayKey(status.observedAt));
				bucket.onlineEvents += 1;
				const end = status.expiresAt ?? status.observedAt + 5 * 60_000;
				bucket.approxOnlineMinutes += Math.max(
					1,
					Math.round((end - status.observedAt) / 60_000),
				);
			}
		}

		const resultDays = [...buckets.entries()]
			.map(([day, value]) => ({ day, ...value }))
			.sort((left, right) => left.day.localeCompare(right.day));

		return {
			days: resultDays,
			totalIncomingMessages: resultDays.reduce(
				(total, day) => total + day.incomingMessages,
				0,
			),
			totalOutgoingMessages: resultDays.reduce(
				(total, day) => total + day.outgoingMessages,
				0,
			),
			totalOnlineEvents: resultDays.reduce(
				(total, day) => total + day.onlineEvents,
				0,
			),
		};
	},
});
