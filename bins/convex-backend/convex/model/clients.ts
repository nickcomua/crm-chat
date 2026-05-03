import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
	humanMutation,
	humanQuery,
	workerMutation,
	workerQuery,
} from "../functions";
import { err, ok, result } from "../helpers/result";
import { mediaSettingsValidator } from "../helpers/validators";

// =============================================================================
// Table-specific validators
// =============================================================================

export const clientKind = v.literal("Telegram");

export const clientPhase = v.union(
	v.literal("Authenticating"),
	v.literal("NeedsSync"),
	v.literal("Syncing"),
	v.literal("Listening"),
	v.literal("Disconnected"),
);

export const clientStatus = v.union(
	v.object({ type: v.literal("Authenticating") }),
	v.object({ type: v.literal("Connected") }),
	v.object({ type: v.literal("Error"), message: v.string() }),
);

const clientFields = v.object({
	userId: v.string(),
	kind: clientKind,
	telegramId: v.string(),
	externalId: v.optional(v.string()),
	phoneNumber: v.optional(v.string()),
	scanningChatIds: v.array(v.string()),
	status: clientStatus,
	phase: v.optional(clientPhase),
	photosSynced: v.optional(v.boolean()),
	mediaSettings: v.optional(mediaSettingsValidator),
});

export const clientDoc = clientFields.extend({
	_id: v.id("clients"),
	_creationTime: v.number(),
});

export const clientsTable = defineTable(clientFields)
	.index("by_userId", ["userId"])
	.index("by_userId_telegramId", ["userId", "telegramId"])
	.index("by_userId_externalId", ["userId", "externalId"])
	.index("by_phase", ["phase"]);

export const deletedClientsTable = defineTable({
	userId: v.string(),
	telegramId: v.string(),
	deletedAt: v.number(),
}).index("by_userId_telegramId", ["userId", "telegramId"]);

const PHONE_AUTH_TERMINAL = new Set(["Connected", "Failed", "Cancelled"]);
const QR_AUTH_TERMINAL = new Set([
	"Authorized",
	"AlreadyAuthorized",
	"Failed",
	"Cancelled",
]);

/** List all clients for the current human user. */
export const list = humanQuery({
	args: {},
	returns: v.array(clientDoc),
	handler: async (ctx) => {
		return await ctx.db
			.query("clients")
			.withIndex("by_userId", (q) => q.eq("userId", ctx.caller.tokenIdentifier))
			.collect();
	},
});

/** Delete a client and cancel associated auth sessions.
 *  Domain cancel-watchers detect the deletion (null phase) and shut down workers. */
export const deleteClient = humanMutation({
	args: { clientId: v.id("clients") },
	returns: result(v.null(), v.literal("Client not found")),
	handler: async (ctx, { clientId }) => {
		const client = await ctx.db.get(clientId);
		if (!client) {
			return err("Client not found");
		}
		if (client.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}

		// Cancel any active phone auth sessions for this client
		const phoneAuths = await ctx.db
			.query("phoneAuths")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();

		const now = Date.now();
		for (const auth of phoneAuths) {
			if (!PHONE_AUTH_TERMINAL.has(auth.step)) {
				await ctx.db.patch(auth._id, {
					step: "Cancelled",
					updatedAt: now,
				});
			}
		}

		// Cancel any active QR auth sessions for this client
		const qrAuths = await ctx.db
			.query("qrAuths")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();

		for (const auth of qrAuths) {
			if (!QR_AUTH_TERMINAL.has(auth.step)) {
				await ctx.db.patch(auth._id, {
					step: "Cancelled",
					updatedAt: now,
				});
			}
		}

		// Write tombstone so workerRegisterConnected won't resurrect this client
		// TODO change to some flag
		await ctx.db.insert("deletedClients", {
			userId: client.userId,
			telegramId: client.telegramId,
			deletedAt: Date.now(),
		});

		await ctx.db.delete(clientId);
		return ok(null);
	},
});

/** Get a single client by ID. Worker-only. */
export const getForWorker = workerQuery({
	args: { clientId: v.id("clients") },
	returns: v.union(clientDoc, v.null()),
	handler: async (ctx, { clientId }) => {
		return await ctx.db.get(clientId);
	},
});

/** Register a pre-authenticated client as Connected. Worker-only.
 *  Sets phase to NeedsSync — the reconciler dispatches DialogSync automatically. */
export const workerRegisterConnected = workerMutation({
	args: {
		userId: v.string(),
		telegramId: v.string(),
		kind: clientKind,
		phoneNumber: v.optional(v.string()),
		externalId: v.optional(v.string()),
	},
	returns: v.union(v.id("clients"), v.null()),
	handler: async (ctx, args) => {
		// Check if this client was previously deleted by the user
		// @todo use some flag
		const tombstone = await ctx.db
			.query("deletedClients")
			.withIndex("by_userId_telegramId", (q) =>
				q.eq("userId", args.userId).eq("telegramId", args.telegramId),
			)
			.unique();
		if (tombstone) {
			return null;
		}

		const { phoneNumber, externalId, ...lookupArgs } = args;
		const existing = await ctx.db
			.query("clients")
			.withIndex("by_userId_telegramId", (q) =>
				q
					.eq("userId", lookupArgs.userId)
					.eq("telegramId", lookupArgs.telegramId),
			)
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				status: { type: "Connected" },
				phase: "NeedsSync" as const,
				...(phoneNumber ? { phoneNumber } : {}),
				...(externalId ? { externalId } : {}),
			});
			return existing._id;
		}
		const id = await ctx.db.insert("clients", {
			...lookupArgs,
			phoneNumber,
			externalId,
			scanningChatIds: [],
			status: { type: "Connected" },
			phase: "NeedsSync" as const,
		});
		return id;
	},
});

/** Trigger a dialog sync for a connected client. Human-only.
 *  Sets phase to NeedsSync — the reconciler dispatches DialogSync. */
export const triggerDialogSync = humanMutation({
	args: { clientId: v.id("clients") },
	returns: result(
		v.null(),
		v.union(v.literal("Client not found"), v.literal("Client not connected")),
	),
	handler: async (ctx, { clientId }) => {
		const client = await ctx.db.get(clientId);
		if (!client) {
			return err("Client not found");
		}
		if (client.userId !== ctx.caller.tokenIdentifier) {
			throw new Error("Unauthorized: you do not own this resource");
		}
		if (client.status.type !== "Connected") {
			return err("Client not connected");
		}
		await ctx.db.patch(clientId, { phase: "NeedsSync" as const });
		return ok(null);
	},
});

// =============================================================================
// Cancel-watcher query (for domain-driven dispatch)
// =============================================================================

/**
 * Lightweight phase query for domain cancel-watcher.
 * Rust handler subscribes to this and cancels when phase becomes "Disconnected".
 */
export const getPhase = workerQuery({
	args: { clientId: v.id("clients") },
	returns: v.union(clientPhase, v.null()),
	handler: async (ctx, { clientId }) => {
		const client = await ctx.db.get(clientId);
		return client?.phase ?? null;
	},
});

// =============================================================================
// Domain lifecycle mutations (for domain-driven dispatch)
// =============================================================================

/** Transition client NeedsSync → Syncing. Worker-only. */
export const workerStartSync = workerMutation({
	args: { clientId: v.id("clients") },
	returns: v.null(),
	handler: async (ctx, { clientId }) => {
		const client = await ctx.db.get(clientId);
		if (!client || client.phase !== "NeedsSync") {
			return null;
		}
		await ctx.db.patch(clientId, { phase: "Syncing" });
		return null;
	},
});

/** Complete dialog sync: Syncing → Listening, photosSynced=false, queue chat scans. Worker-only. */
export const workerCompleteSync = workerMutation({
	args: { clientId: v.id("clients") },
	returns: v.null(),
	handler: async (ctx, { clientId }) => {
		const client = await ctx.db.get(clientId);
		if (!client) {
			return null;
		}
		await ctx.db.patch(clientId, {
			phase: "Listening",
		});

		// Queue scan for scan-enabled chats that haven't been fully scanned
		const chats = await ctx.db
			.query("chats")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();

		for (const chat of chats) {
			if (chat.scanEnabled && !chat.fullScanned) {
				await ctx.db.patch(chat._id, { scanPhase: "Queued" });
			}
		}

		return null;
	},
});

/** Mark a client as having a session error. Worker-only.
 *  Sets status to Error and phase to Disconnected so the UI shows the problem
 *  and no more jobs are dispatched for this client. */
export const workerMarkSessionError = workerMutation({
	args: {
		userId: v.string(),
		telegramId: v.string(),
		message: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, { userId, telegramId, message }) => {
		const client = await ctx.db
			.query("clients")
			.withIndex("by_userId_telegramId", (q) =>
				q.eq("userId", userId).eq("telegramId", telegramId),
			)
			.unique();
		if (!client) {
			return null;
		}
		await ctx.db.patch(client._id, {
			status: { type: "Error", message },
			phase: "Disconnected",
		});
		return null;
	},
});

/** Mark profile photos as synced for a client. Worker-only. */
export const workerMarkPhotosSynced = workerMutation({
	args: { clientId: v.id("clients") },
	returns: v.null(),
	handler: async (ctx, { clientId }) => {
		const client = await ctx.db.get(clientId);
		if (!client) {
			return null;
		}
		await ctx.db.patch(clientId, { photosSynced: true });
		return null;
	},
});

const pendingClientWorkItem = v.object({
	service: v.union(v.literal("DialogSync"), v.literal("UpdateListener")),
	key: v.id("clients"),
	handler: v.string(),
});

export const pendingWork = workerQuery({
	args: {},
	returns: v.array(pendingClientWorkItem),
	handler: async (ctx) => {
		const work: Array<typeof pendingClientWorkItem.type> = [];

		const needsOrSyncing = [
			...(await ctx.db
				.query("clients")
				.withIndex("by_phase", (q) => q.eq("phase", "NeedsSync"))
				.collect()),
			...(await ctx.db
				.query("clients")
				.withIndex("by_phase", (q) => q.eq("phase", "Syncing"))
				.collect()),
		];

		for (const c of needsOrSyncing) {
			work.push({ service: "DialogSync", key: c._id, handler: "sync" });
		}

		const listening = await ctx.db
			.query("clients")
			.withIndex("by_phase", (q) => q.eq("phase", "Listening"))
			.collect();

		for (const c of listening) {
			work.push({
				service: "UpdateListener",
				key: c._id,
				handler: "listen",
			});
		}

		return work;
	},
});
