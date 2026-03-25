/**
 * Domain-driven dispatch: the single `pendingWork` query is the entry point
 * for all worker orchestration. The Rust reconciler subscribes to this query
 * and dispatches each item to Restate. No command queue table needed —
 * domain entity state IS the queue.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireWorker } from "./helpers/auth";

// =============================================================================
// Work-item validator — fully typed, exhaustive on both TS and Rust codegen
// =============================================================================

export const workItemValidator = v.union(
  v.object({
    service: v.literal("PhoneAuthWorkflow"),
    key: v.id("phoneAuths"),
    handler: v.literal("run"),
  }),
  v.object({
    service: v.literal("QrAuthWorkflow"),
    key: v.id("qrAuths"),
    handler: v.literal("run"),
  }),
  v.object({
    service: v.literal("DialogSync"),
    key: v.id("clients"),
    handler: v.literal("sync"),
  }),
  v.object({
    service: v.literal("UpdateListener"),
    key: v.id("clients"),
    handler: v.literal("listen"),
  }),
  v.object({
    service: v.literal("ProfilePhotoSync"),
    key: v.id("clients"),
    handler: v.literal("sync"),
  }),
  v.object({
    service: v.literal("ChatScanner"),
    key: v.id("chats"),
    handler: v.literal("scan"),
  }),
  v.object({
    service: v.literal("MediaDownloader"),
    key: v.id("media"),
    handler: v.literal("download"),
  })
);

// =============================================================================
// The single reactive query — orchestrator subscribes to this
// =============================================================================

/**
 * Return all work that needs to be dispatched to Restate.
 *
 * Each item represents a domain entity in a state that requires a Restate
 * handler to run. The orchestrator's in-memory `in_flight` set prevents
 * double-dispatch; Restate's virtual-object/workflow keying is the ultimate
 * dedup guarantee.
 */
// i dont like this one monster query i thing we need to split it to be one cuery per table
export const pendingWork = query({
  args: { maxMediaDownloads: v.optional(v.number()) },
  returns: v.array(workItemValidator),
  handler: async (ctx, { maxMediaDownloads }) => {
    await requireWorker(ctx);

    type WorkItem = typeof workItemValidator.type;
    const work: WorkItem[] = [];

    // ── Phone auth sessions needing workers ──────────────────────
    for (const step of [
      "SendingCode",
      "VerifyingCode",
      "VerifyingPassword",
    ] as const) {
      const auths = await ctx.db
        .query("phoneAuths")
        .withIndex("by_step", (q) => q.eq("step", step))
        .collect();
      for (const a of auths) {
        work.push({
          service: "PhoneAuthWorkflow",
          key: a._id,
          handler: "run",
        });
      }
    }

    // ── QR auth sessions needing workers ─────────────────────────
    const qrPending = await ctx.db
      .query("qrAuths")
      .withIndex("by_step", (q) => q.eq("step", "Pending"))
      .collect();
    for (const a of qrPending) {
      work.push({
        service: "QrAuthWorkflow",
        key: a._id,
        handler: "run",
      });
    }

    // ── Clients needing dialog sync ──────────────────────────────
    const needsSync = await ctx.db
      .query("clients")
      .withIndex("by_phase", (q) => q.eq("phase", "NeedsSync"))
      .collect();
    for (const c of needsSync) {
      work.push({ service: "DialogSync", key: c._id, handler: "sync" });
    }

    // ── Connected clients needing listeners ──────────────────────
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
      // Also dispatch ProfilePhotoSync for clients that haven't synced photos
      if (c.photosSynced === false) {
        work.push({
          service: "ProfilePhotoSync",
          key: c._id,
          handler: "sync",
        });
      }
    }

    // ── Chats needing scan ───────────────────────────────────────
    const queuedChats = await ctx.db
      .query("chats")
      .withIndex("by_scanPhase", (q) => q.eq("scanPhase", "Queued"))
      .collect();
    for (const c of queuedChats) {
      work.push({ service: "ChatScanner", key: c._id, handler: "scan" });
    }

    // ── Media needing download (with concurrency limit) ──────────
    const limit = maxMediaDownloads ?? 0;
    const allPendingMedia = await ctx.db
      .query("media")
      .filter((q) => q.eq(q.field("status"), "Pending"))
      .collect();

    if (limit > 0) {
      const allDownloading = await ctx.db
        .query("media")
        .filter((q) => q.eq(q.field("status"), "Downloading"))
        .collect();
      const slots = Math.max(0, limit - allDownloading.length);
      for (const m of allPendingMedia.slice(0, slots)) {
        work.push({
          service: "MediaDownloader",
          key: m._id,
          handler: "download",
        });
      }
    } else {
      // No limit — dispatch all pending media
      for (const m of allPendingMedia) {
        work.push({
          service: "MediaDownloader",
          key: m._id,
          handler: "download",
        });
      }
    }

    return work;
  },
});
