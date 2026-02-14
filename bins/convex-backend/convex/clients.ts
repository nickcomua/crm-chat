import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  isPhoneAuthTerminal,
  requireHuman,
  requireOwner,
  requireRobot,
} from "./helpers/auth";
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
  returns: v.null(),
  handler: async (ctx, { clientId }) => {
    const caller = await requireHuman(ctx);
    const client = await ctx.db.get(clientId);
    if (!client) {
      throw new Error("Client not found");
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
  },
});

/** List all connected clients. Robot-only (for scanning). */
export const connectedForRobot = query({
  args: {},
  returns: v.array(clientDoc),
  handler: async (ctx) => {
    await requireRobot(ctx);
    const all = await ctx.db.query("clients").collect();
    return all.filter((c) => c.status.type === "Connected");
  },
});

/** Register a pre-authenticated client as Connected. Robot-only. */
export const robotRegisterConnected = mutation({
  args: {
    userId: v.string(),
    externalId: v.string(),
    kind: clientKind,
  },
  returns: v.id("clients"),
  handler: async (ctx, args) => {
    await requireRobot(ctx);
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_userId_externalId", (q) =>
        q.eq("userId", args.userId).eq("externalId", args.externalId)
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { status: { type: "Connected" } });
      return existing._id;
    }
    return await ctx.db.insert("clients", {
      ...args,
      activeChats: [],
      status: { type: "Connected" },
    });
  },
});
