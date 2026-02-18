import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
	isQrAuthTerminal,
	requireAssignedWorker,
	requireHuman,
	requireWorker,
} from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueTask } from "./helpers/tasks";
import { completeQrAuth } from "./qrAuth";
import { workerTask, workerTaskDoc, workerTaskStatus } from "./schema";

/**
 * All pending tasks for the worker to dispatch. Worker-only.
 *
 * When `maxMediaWorkflows` > 0, counts in-flight (Dispatched) MediaDownloader
 * tasks and excludes excess Pending MediaDownloader tasks so the
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

		// Count in-flight MediaDownloader tasks (Dispatched + Running)
		let activeMedia = 0;
		for (const status of ["Dispatched", "Running"] as const) {
			const tasks = await ctx.db
				.query("workerTasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			activeMedia += tasks.filter(
				(t) => t.task.type === "MediaDownloader",
			).length;
		}

		const slotsAvailable = Math.max(0, limit - activeMedia);
		let mediaAllowed = slotsAvailable;

		return pending.filter((task) => {
			if (task.task.type === "MediaDownloader") {
				if (mediaAllowed <= 0) return false;
				mediaAllowed--;
			}
			return true;
		});
	},
});

/**
 * Get a task by ID for the current human user.
 * Returns null if the task doesn't exist or belongs to another user.
 */
export const getTaskById = query({
	args: { taskId: v.id("workerTasks") },
	returns: v.union(v.null(), workerTaskDoc),
	handler: async (ctx, { taskId }) => {
		const caller = await requireHuman(ctx);
		const task = await ctx.db.get(taskId);
		if (!task || task.userId !== caller.id) return null;
		return task;
	},
});

/**
 * Get task status by ID. Worker-only.
 * Returns just the status string (or null if not found).
 * Used by cancel watcher subscriptions.
 */
export const getTaskStatus = query({
	args: { taskId: v.id("workerTasks") },
	returns: v.union(v.null(), workerTaskStatus),
	handler: async (ctx, { taskId }) => {
		await requireWorker(ctx);
		const task = await ctx.db.get(taskId);
		return task?.status ?? null;
	},
});

/**
 * Cancel a task by ID. Human-only.
 * Patches the task status to Cancelled. Worker detects this via subscription.
 */
export const cancelTask = mutation({
	args: { taskId: v.id("workerTasks") },
	returns: result(v.null()),
	handler: async (ctx, { taskId }) => {
		const caller = await requireHuman(ctx);
		const task = await ctx.db.get(taskId);
		if (!task || task.userId !== caller.id) return err("Not found");
		if (task.status === "Cancelled") return ok(null);
		await ctx.db.patch(taskId, { status: "Cancelled" });
		return ok(null);
	},
});

/**
 * Mark a task as dispatched to Restate and claim it for this worker.
 * Pending → Dispatched. Records `claimedByWorkerId` so subsequent
 * mutations can verify the caller owns the task.
 */
export const markDispatched = mutation({
	args: { taskId: v.id("workerTasks") },
	returns: v.null(),
	handler: async (ctx, { taskId }) => {
		const caller = await requireWorker(ctx);
		const task = await ctx.db.get(taskId);
		if (!task || task.status !== "Pending") return null;
		await ctx.db.patch(taskId, {
			status: "Dispatched",
			dispatchedAt: Date.now(),
			claimedByWorkerId: caller.id,
		});
		return null;
	},
});

/**
 * Mark a task as running. Worker-only. Dispatched → Running.
 *
 * Called by every Restate handler at the start of execution.
 * The gap between Dispatched and Running is time spent in Restate's queue.
 */
export const runTask = mutation({
	args: { taskId: v.id("workerTasks") },
	returns: result(v.null()),
	handler: async (ctx, { taskId }) => {
		const caller = await requireWorker(ctx);
		const task = await ctx.db.get(taskId);
		if (!task) return err("Task not found");
		if (task.status !== "Dispatched") {
			return err(`Expected Dispatched, got ${task.status}`);
		}
		requireAssignedWorker(caller.id, task.claimedByWorkerId);
		await ctx.db.patch(taskId, { status: "Running" });
		return ok(null);
	},
});

/**
 * Universal mid-flight task update. Worker-only.
 *
 * The worker sends the full updated task variant. The handler validates
 * the type matches and the task isn't in a terminal state, then patches.
 */
export const workerUpdateTask = mutation({
	args: {
		taskId: v.id("workerTasks"),
		task: workerTask,
	},
	returns: result(v.null()),
	handler: async (ctx, { taskId, task: newTask }) => {
		const caller = await requireWorker(ctx);
		const existing = await ctx.db.get(taskId);
		if (!existing) return err("Task not found");
		requireAssignedWorker(caller.id, existing.claimedByWorkerId);

		if (newTask.type !== existing.task.type) {
			return err(`Type mismatch: expected ${existing.task.type}, got ${newTask.type}`);
		}

		if (newTask.type === "QrAuth" && isQrAuthTerminal(newTask.step)) {
			return err("Cannot update: auth is in a terminal state");
		}

		await ctx.db.patch(taskId, { task: newTask });
		return ok(null);
	},
});

// =============================================================================
// Completion handlers — run atomically inside workerComplete
// =============================================================================

/** Enqueue ProfilePhotoSync + ChatScanner for unscanned chats after dialog sync. */
async function completeDialogSync(
	ctx: MutationCtx,
	task: { clientId: Id<"clients">; userId: string; telegramId: string },
): Promise<void> {
	const client = await ctx.db.get(task.clientId);
	if (!client) return;

	const chats = await ctx.db
		.query("chats")
		.withIndex("by_clientId", (q) => q.eq("clientId", client._id))
		.collect();

	await enqueueTask(ctx, {
		type: "ProfilePhotoSync",
		clientId: client._id,
		userId: client.userId,
		telegramId: client.telegramId,
		chats: chats.map((c) => ({
			chatId: c.chatId,
			photoExternalId: c.photoExternalId,
		})),
	});

	for (const chat of chats) {
		if (chat.scanEnabled && !chat.fullScanned) {
			await enqueueTask(ctx, {
				type: "ChatScanner",
				chatId: chat.chatId,
				clientId: client._id,
				userId: client.userId,
				isPinned: chat.isPinned,
				pinnedName: chat.pinnedName,
			});
		}
	}
}

/** Mark a chat as fully scanned and set scanPhase to Listening. */
async function completeChatScanner(
	ctx: MutationCtx,
	task: { chatId: string },
): Promise<void> {
	const chat = await ctx.db
		.query("chats")
		.withIndex("by_chatId", (q) => q.eq("chatId", task.chatId))
		.unique();
	if (!chat) return;

	await ctx.db.patch(chat._id, {
		fullScanned: true,
		scanPhase: "Listening" as const,
	});
}

/**
 * Reset all Dispatched and Running tasks back to Pending. Worker-only.
 *
 * Called once at worker startup so that tasks stranded by a previous crash or
 * restart cycle are re-dispatched. Restate's virtual-object keying guarantees
 * idempotency — duplicate dispatches to the same key are harmless.
 */
export const resetStale = mutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		await requireWorker(ctx);
		let count = 0;
		for (const status of ["Dispatched", "Running"] as const) {
			const tasks = await ctx.db
				.query("workerTasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const task of tasks) {
				await ctx.db.patch(task._id, {
					status: "Pending",
					dispatchedAt: undefined,
				});
			}
			count += tasks.length;
		}
		return count;
	},
});

/**
 * Universal task completion. Worker-only.
 *
 * Optionally accepts the final task state (required for types that carry
 * completion data, e.g. QrAuth with telegramUserId). If provided the task
 * variant is patched first, then type-specific side-effects run, and
 * finally the row is deleted to free the dedup slot.
 */
export const workerComplete = mutation({
	args: {
		taskId: v.id("workerTasks"),
		task: v.optional(workerTask),
	},
	returns: result(v.null()),
	handler: async (ctx, { taskId, task: finalTask }) => {
		const caller = await requireWorker(ctx);
		const row = await ctx.db.get(taskId);
		if (!row) return err("Task not found");
		requireAssignedWorker(caller.id, row.claimedByWorkerId);

		// Patch final task state if provided
		if (finalTask) {
			if (finalTask.type !== row.task.type) {
				return err(`Type mismatch: expected ${row.task.type}, got ${finalTask.type}`);
			}
			await ctx.db.patch(taskId, { task: finalTask });
		}

		const task = finalTask ?? row.task;

		// ── Type-specific completion logic ──────────────────────────
		switch (task.type) {
			case "QrAuth":
				await completeQrAuth(ctx, row.userId, task);
				break;
			case "DialogSync":
				await completeDialogSync(ctx, task);
				break;
			case "ChatScanner":
				await completeChatScanner(ctx, task);
				break;
		}

		// ── Clean up — frees the dedup slot ────────────────────────
		await ctx.db.delete(taskId);
		return ok(null);
	},
});


