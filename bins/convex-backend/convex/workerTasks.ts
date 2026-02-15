import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { workerTaskDoc } from "./schema";
import { requireWorker } from "./helpers/auth";
import { enqueueTask } from "./helpers/tasks";

/**
 * All pending tasks for the worker to dispatch. Worker-only.
 *
 * When `maxMediaWorkflows` > 0, counts in-flight (Dispatched) MediaDownloader
 * tasks and excludes excess Pending MediaDownloader/download tasks so the
 * orchestrator never exceeds the parallel download limit.
 */
export const pendingForWorker = query({
	args: { maxMediaWorkflows: v.optional(v.number()) },
	returns: v.array(workerTaskDoc),
	handler: async (ctx, { maxMediaWorkflows }) => {
		await requireWorker(ctx);
		const pending = await ctx.db
			.query("workerTasks")
			.withIndex("by_status", (q) => q.eq("status", "Pending"))
			.collect();

		const limit = maxMediaWorkflows ?? 0;
		if (limit <= 0) return pending;

		// Count in-flight MediaDownloader/download tasks
		const dispatched = await ctx.db
			.query("workerTasks")
			.withIndex("by_status", (q) => q.eq("status", "Dispatched"))
			.collect();
		const activeMedia = dispatched.filter(
			(t) => t.service === "MediaDownloader" && t.handler === "download",
		).length;

		const slotsAvailable = Math.max(0, limit - activeMedia);
		let mediaAllowed = slotsAvailable;

		return pending.filter((task) => {
			if (task.service === "MediaDownloader" && task.handler === "download") {
				if (mediaAllowed <= 0) return false;
				mediaAllowed--;
			}
			return true;
		});
	},
});

/** Mark a task as dispatched to Restate. Worker-only. */
export const markDispatched = mutation({
	args: { taskId: v.id("workerTasks") },
	returns: v.null(),
	handler: async (ctx, { taskId }) => {
		await requireWorker(ctx);
		const task = await ctx.db.get(taskId);
		if (!task || task.status !== "Pending") return null;
		await ctx.db.patch(taskId, {
			status: "Dispatched",
			dispatchedAt: Date.now(),
		});
		return null;
	},
});

/**
 * Enqueue post-DialogSync tasks for a client. Worker-only.
 *
 * Called by the DialogSync Restate handler after sync_dialogs() completes.
 * Creates ProfilePhotoSync + ChatScanner tasks for unscanned chats.
 */
export const enqueuePostSyncTasks = mutation({
	args: { clientId: v.id("clients") },
	returns: v.null(),
	handler: async (ctx, { clientId }) => {
		await requireWorker(ctx);
		const client = await ctx.db.get(clientId);
		if (!client) return null;
		const payload = JSON.stringify(client);

		// ProfilePhotoSync
		await enqueueTask(ctx, "ProfilePhotoSync", "sync", clientId, payload);

		// ChatScanner for each unscanned chat
		const chats = await ctx.db
			.query("chats")
			.withIndex("by_clientId", (q) => q.eq("clientId", clientId))
			.collect();
		for (const chat of chats) {
			if (chat.scanEnabled && !chat.fullScanned) {
				await enqueueTask(
					ctx,
					"ChatScanner",
					"scan",
					chat.chatId,
					JSON.stringify(chat),
				);
			}
		}
		return null;
	},
});

const CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_BATCH = 200;

/** Delete old Dispatched tasks. Self-scheduling. */
export const cleanup = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - CLEANUP_AGE_MS;
		const old = await ctx.db
			.query("workerTasks")
			.withIndex("by_status", (q) => q.eq("status", "Dispatched"))
			.take(CLEANUP_BATCH);

		let deleted = 0;
		for (const task of old) {
			if (task.dispatchedAt && task.dispatchedAt < cutoff) {
				await ctx.db.delete(task._id);
				deleted++;
			}
		}

		// Re-schedule if we hit the batch limit
		if (deleted === CLEANUP_BATCH) {
			await ctx.scheduler.runAfter(0, internal.workerTasks.cleanup, {});
		}
	},
});
