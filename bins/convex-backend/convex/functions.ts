/**
 * Custom mutation/internalMutation with database triggers.
 *
 * Import `mutation` and `internalMutation` from this file (instead of
 * `_generated/server`) in any file that writes to trigger-enabled tables.
 *
 * Currently registers a trigger on the `humans` table to cancel orphaned
 * QR auth tasks when a user goes offline (online: true → false).
 */

import {
  customCtx,
  customMutation,
} from "convex-helpers/server/customFunctions";
import { Triggers } from "convex-helpers/server/triggers";
import type { DataModel } from "./_generated/dataModel";
import {
  internalMutation as rawInternalMutation,
  mutation as rawMutation,
} from "./_generated/server";

const triggers = new Triggers<DataModel>();

/**
 * When a human goes offline, cancel all their active QR auth sessions.
 *
 * This fires atomically inside the same mutation that sets `online: false`
 * (either our disconnect wrapper or the heartbeat timeout path).
 * No cron needed — the presence component's heartbeat timeout drives the
 * disconnect, which updates `humans.online`, which fires this trigger.
 */
// TODO crop trigers and move this directly to @presence.ts
triggers.register("humans", async (ctx, change) => {
  if (change.operation === "delete") {
    return;
  }
  if (change.operation === "insert") {
    return;
  }

  const { oldDoc, newDoc } = change;
  if (oldDoc.online && !newDoc.online) {
    const { userId } = newDoc;
    const qrAuths = await ctx.db
      .query("qrAuths")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    for (const auth of qrAuths) {
      // Only cancel non-terminal QR auth sessions
      if (
        auth.step === "Pending" ||
        auth.step === "Generating" ||
        auth.step === "Token"
      ) {
        await ctx.db.patch(auth._id, {
          step: "Cancelled",
          updatedAt: Date.now(),
        });
      }
    }
  }
});

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
export const internalMutation = customMutation(
  rawInternalMutation,
  customCtx(triggers.wrapDB)
);
