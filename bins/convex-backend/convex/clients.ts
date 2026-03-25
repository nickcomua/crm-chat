import { v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import {
  isPhoneAuthTerminal,
  isQrAuthTerminal,
  requireHuman,
  requireOwner,
  requireWorker,
} from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { clientDoc, clientKind, clientPhase } from "./schema";

/** List all clients for the current human user. */
export const list = query({
  args: {},
  returns: v.array(clientDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    return await ctx.db
      .query("clients")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .collect();
  },
});

/** Delete a client and cancel associated auth sessions.
 *  Sets phase to Disconnected so domain cancel-watchers fire. */
export const deleteClient = mutation({
  args: { clientId: v.id("clients") },
  returns: result(v.null(), v.literal("Client not found")),
  handler: async (ctx, { clientId }) => {
    const caller = await requireHuman(ctx);
    const client = await ctx.db.get(clientId);
    if (!client) {
      return err("Client not found");
    }
    requireOwner(caller.id, client.userId);

    // Cancel any active phone auth sessions for this client
    const phoneAuths = await ctx.db
      .query("phoneAuths")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .collect();

    const now = Date.now();
    for (const auth of phoneAuths) {
      if (!isPhoneAuthTerminal(auth.step)) {
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
      if (!isQrAuthTerminal(auth.step)) {
        await ctx.db.patch(auth._id, {
          step: "Cancelled",
          updatedAt: now,
        });
      }
    }

    await ctx.db.delete(clientId);
    return ok(null);
  },
});

/** Get a single client by ID. Worker-only. */
export const getForWorker = query({
  args: { clientId: v.id("clients") },
  returns: v.union(clientDoc, v.null()),
  handler: async (ctx, { clientId }) => {
    await requireWorker(ctx);
    return await ctx.db.get(clientId);
  },
});

/** Register a pre-authenticated client as Connected. Worker-only.
 *  Sets phase to NeedsSync — the reconciler dispatches DialogSync automatically. */
export const workerRegisterConnected = mutation({
  args: {
    userId: v.string(),
    telegramId: v.string(),
    kind: clientKind,
    phoneNumber: v.optional(v.string()),
    externalId: v.optional(v.string()),
  },
  returns: v.id("clients"),
  handler: async (ctx, args) => {
    await requireWorker(ctx);
    const { phoneNumber, externalId, ...lookupArgs } = args;
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_userId_telegramId", (q) =>
        q
          .eq("userId", lookupArgs.userId)
          .eq("telegramId", lookupArgs.telegramId)
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
export const triggerDialogSync = mutation({
  args: { clientId: v.id("clients") },
  returns: result(
    v.null(),
    v.union(v.literal("Client not found"), v.literal("Client not connected"))
  ),
  handler: async (ctx, { clientId }) => {
    const caller = await requireHuman(ctx);
    const client = await ctx.db.get(clientId);
    if (!client) {
      return err("Client not found");
    }
    requireOwner(caller.id, client.userId);
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
export const getPhase = query({
  args: { clientId: v.id("clients") },
  returns: v.union(clientPhase, v.null()),
  handler: async (ctx, { clientId }) => {
    await requireWorker(ctx);
    const client = await ctx.db.get(clientId);
    return client?.phase ?? null;
  },
});

// =============================================================================
// Domain lifecycle mutations (for domain-driven dispatch)
// =============================================================================

/** Transition client NeedsSync → Syncing. Worker-only. */
export const workerStartSync = mutation({
  args: { clientId: v.id("clients") },
  returns: v.null(),
  handler: async (ctx, { clientId }) => {
    await requireWorker(ctx);
    const client = await ctx.db.get(clientId);
    if (!client || client.phase !== "NeedsSync") {
      return null;
    }
    await ctx.db.patch(clientId, { phase: "Syncing" });
    return null;
  },
});

/** Complete dialog sync: Syncing → Listening, photosSynced=false, queue chat scans. Worker-only. */
export const workerCompleteSync = mutation({
  args: { clientId: v.id("clients") },
  returns: v.null(),
  handler: async (ctx, { clientId }) => {
    await requireWorker(ctx);
    const client = await ctx.db.get(clientId);
    if (!client) {
      return null;
    }
    await ctx.db.patch(clientId, {
      phase: "Listening",
      photosSynced: false,
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

/** Mark profile photos as synced for a client. Worker-only. */
export const workerMarkPhotosSynced = mutation({
  args: { clientId: v.id("clients") },
  returns: v.null(),
  handler: async (ctx, { clientId }) => {
    await requireWorker(ctx);
    const client = await ctx.db.get(clientId);
    if (!client) {
      return null;
    }
    await ctx.db.patch(clientId, { photosSynced: true });
    return null;
  },
});
