import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { clientDoc, clientKind } from "./schema";
import { requireHuman, requireOwner, requireWorker, isPhoneAuthTerminal } from "./helpers/auth";
import { err, ok, result } from "./helpers/result";

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

    await ctx.db.delete(clientId);
    return ok(null);
  },
});

/** List all connected clients. Worker-only (for scanning). */
export const connectedForWorker = query({
  args: {},
  returns: v.array(clientDoc),
  handler: async (ctx) => {
    await requireWorker(ctx);
    const all = await ctx.db.query("clients").collect();
    return all.filter((c) => c.status.type === "Connected");
  },
});

/** Register a pre-authenticated client as Connected. Worker-only. */
export const workerRegisterConnected = mutation({
  args: {
    userId: v.string(),
    telegramId: v.string(),
    kind: clientKind,
  },
  returns: result(v.id("clients")),
  handler: async (ctx, args) => {
    await requireWorker(ctx);
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_userId_telegramId", (q) =>
        q.eq("userId", args.userId).eq("telegramId", args.telegramId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { status: { type: "Connected" } });
      return ok(existing._id);
    }
    const id = await ctx.db.insert("clients", {
      ...args,
      scanningChatIds: [],
      status: { type: "Connected" },
    });
    return ok(id);
  },
});
