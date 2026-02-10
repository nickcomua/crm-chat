import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAuth, requireHuman, requireOwner, isPhoneAuthTerminal } from "./helpers/auth";

/** List all clients for the current human user. */
export const list = query({
  args: {},
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
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .collect();

    const now = Date.now();
    for (const auth of phoneAuths) {
      if (auth.clientId === clientId && !isPhoneAuthTerminal(auth.step)) {
        await ctx.db.patch(auth._id, {
          step: "Cancelled",
          updatedAt: now,
        });
      }
    }

    await ctx.db.delete(clientId);
  },
});
