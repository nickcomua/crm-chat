import { v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import {
  isPhoneAuthTerminal,
  requireHuman,
  requireOwner,
  requireWorker,
} from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { cancelClientTasks, enqueueTask } from "./helpers/tasks";
import { clientDoc, clientKind } from "./schema";

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

/** Delete a client and cancel associated auth sessions. */
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

    // Cancel all active worker tasks for this client
    await cancelClientTasks(ctx, clientId);

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

/** Register a pre-authenticated client as Connected. Worker-only. */
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
        ...(phoneNumber ? { phoneNumber } : {}),
        ...(externalId ? { externalId } : {}),
      });
      await enqueueTask(ctx, {
        type: "UpdateListener",
        clientId: existing._id,
        userId: existing.userId,
        telegramId: existing.telegramId,
      });
      await enqueueTask(ctx, {
        type: "DialogSync",
        clientId: existing._id,
        userId: existing.userId,
        telegramId: existing.telegramId,
      });
      return existing._id;
    }
    const id = await ctx.db.insert("clients", {
      ...lookupArgs,
      phoneNumber,
      externalId,
      scanningChatIds: [],
      status: { type: "Connected" },
    });
    await enqueueTask(ctx, {
      type: "UpdateListener",
      clientId: id,
      userId: lookupArgs.userId,
      telegramId: lookupArgs.telegramId,
    });
    await enqueueTask(ctx, {
      type: "DialogSync",
      clientId: id,
      userId: lookupArgs.userId,
      telegramId: lookupArgs.telegramId,
    });
    return id;
  },
});

/** Trigger a dialog sync for a connected client. Human-only. */
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
    await enqueueTask(ctx, {
      type: "DialogSync",
      clientId: client._id,
      userId: client.userId,
      telegramId: client.telegramId,
    });
    return ok(null);
  },
});
