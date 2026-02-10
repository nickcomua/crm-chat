import { internalMutation } from "./_generated/server";
import { isPhoneAuthTerminal, isQrAuthTerminal } from "./helpers/auth";

const STALE_THRESHOLD_MS = 90_000; // 90 seconds without heartbeat = stale

/**
 * Mark stale humans/robots offline and clean up their auth sessions.
 * Replaces SpacetimeDB's client_disconnected lifecycle reducer.
 */
export const staleConnections = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - STALE_THRESHOLD_MS;

    // --- Clean up stale humans ---
    const onlineHumans = await ctx.db
      .query("humans")
      .withIndex("by_online", (q) => q.eq("online", true))
      .collect();

    for (const human of onlineHumans) {
      if (human.lastHeartbeat < cutoff) {
        // Mark offline
        await ctx.db.patch(human._id, { online: false, updatedAt: now });

        // Cancel active phone auths owned by this human
        const phoneAuths = await ctx.db
          .query("phoneAuths")
          .withIndex("by_userId", (q) => q.eq("userId", human.userId))
          .collect();
        for (const auth of phoneAuths) {
          if (!isPhoneAuthTerminal(auth.step)) {
            await ctx.db.patch(auth._id, {
              step: "Cancelled",
              updatedAt: now,
            });
          }
        }

        // Cancel active QR auths owned by this human
        const qrAuths = await ctx.db
          .query("qrAuths")
          .withIndex("by_userId", (q) => q.eq("userId", human.userId))
          .collect();
        for (const auth of qrAuths) {
          if (!isQrAuthTerminal(auth.step)) {
            await ctx.db.patch(auth._id, {
              step: "Cancelled",
              updatedAt: now,
            });
          }
        }
      }
    }

    // --- Clean up stale robots ---
    const onlineRobots = await ctx.db
      .query("robots")
      .withIndex("by_online", (q) => q.eq("online", true))
      .collect();

    for (const robot of onlineRobots) {
      if (robot.lastHeartbeat < cutoff) {
        // Mark offline
        await ctx.db.patch(robot._id, { online: false, updatedAt: now });

        // Fail active phone auths assigned to this robot
        const phoneAuths = await ctx.db
          .query("phoneAuths")
          .withIndex("by_assignedRobot", (q) => q.eq("assignedRobot", robot.robotId))
          .collect();
        for (const auth of phoneAuths) {
          if (!isPhoneAuthTerminal(auth.step)) {
            // Delete the associated client
            const client = await ctx.db.get(auth.clientId);
            if (client) {
              await ctx.db.delete(auth.clientId);
            }
            // Send error notification
            await ctx.db.insert("notifications", {
              userId: auth.userId,
              severity: "Error",
              message:
                "Authentication was interrupted because the server disconnected. Please try again.",
              dismissed: false,
            });
            await ctx.db.patch(auth._id, {
              step: "Failed",
              error: "Robot disconnected",
              updatedAt: now,
            });
          }
        }

        // Fail active QR auths assigned to this robot
        const qrAuths = await ctx.db
          .query("qrAuths")
          .withIndex("by_assignedRobot", (q) => q.eq("assignedRobot", robot.robotId))
          .collect();
        for (const auth of qrAuths) {
          if (!isQrAuthTerminal(auth.step)) {
            await ctx.db.insert("notifications", {
              userId: auth.userId,
              severity: "Error",
              message:
                "Authentication was interrupted because the server disconnected. Please try again.",
              dismissed: false,
            });
            await ctx.db.patch(auth._id, {
              step: "Failed",
              error: "Robot disconnected",
              updatedAt: now,
            });
          }
        }
      }
    }
  },
});
