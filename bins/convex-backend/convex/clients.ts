import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { clientDoc, clientKind } from "./schema";
import { requireHuman, requireOwner, requireWorker, isPhoneAuthTerminal } from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueClientStart, enqueueClientStop } from "./helpers/tasks";

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
  returns: result(v.null()),
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

    // Enqueue stop tasks for all services of this client
    await enqueueClientStop(ctx, clientId);

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
  },
  returns: result(v.id("clients")),
  handler: async (ctx, args) => {
    await requireWorker(ctx);
    const { phoneNumber, ...lookupArgs } = args;
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_userId_telegramId", (q) =>
        q.eq("userId", lookupArgs.userId).eq("telegramId", lookupArgs.telegramId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: { type: "Connected" },
        ...(phoneNumber ? { phoneNumber } : {}),
      });
      const client = await ctx.db.get(existing._id);
      if (client) await enqueueClientStart(ctx, client);
      return ok(existing._id);
    }
    const id = await ctx.db.insert("clients", {
      ...lookupArgs,
      phoneNumber,
      scanningChatIds: [],
      status: { type: "Connected" },
    });
    const client = await ctx.db.get(id);
    if (client) await enqueueClientStart(ctx, client);
    return ok(id);
  },
});
