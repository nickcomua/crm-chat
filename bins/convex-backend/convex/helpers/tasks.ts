import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { workerTask } from "../schema";

type WorkerTask = Infer<typeof workerTask>;

/**
 * Extract a deduplication key from a typed worker task.
 * Tasks with the same (type, dedupKey) are considered duplicates.
 */
function getDeduplicationKey(task: WorkerTask): string {
	switch (task.type) {
		case "PhoneAuth:run":
		case "PhoneAuth:submitCode":
		case "PhoneAuth:submitPassword":
		case "PhoneAuth:cancel":
		case "QrAuth:run":
		case "QrAuth:cancel":
			return task.authId;

		case "DialogSync:sync":
		case "UpdateListener:listen":
		case "UpdateListener:stop":
		case "ProfilePhotoSync:sync":
		case "ProfilePhotoSync:stop":
			return task.clientId;

		case "ChatScanner:scan":
			return task.chatId;

		case "MediaDownloader:download":
			return task.telegramFileId;
	}
}

/**
 * Enqueue a typed worker task with deduplication.
 *
 * Checks for an existing Pending or Dispatched task with the same
 * (type, dedupKey) before inserting. If one already exists, this is a no-op.
 *
 * Uses `by_status` index + in-memory filtering since the workerTasks table
 * only contains active (Pending/Dispatched) rows — always small.
 */
export async function enqueueTask(
	ctx: MutationCtx,
	task: WorkerTask,
): Promise<void> {
	const key = getDeduplicationKey(task);

	// Dedup: check Pending tasks
	const pending = await ctx.db
		.query("workerTasks")
		.withIndex("by_status", (q) => q.eq("status", "Pending"))
		.collect();
	if (pending.some((t) => t.task.type === task.type && getDeduplicationKey(t.task) === key)) {
		return;
	}

	// Dedup: check Dispatched (in-flight) tasks
	const dispatched = await ctx.db
		.query("workerTasks")
		.withIndex("by_status", (q) => q.eq("status", "Dispatched"))
		.collect();
	if (dispatched.some((t) => t.task.type === task.type && getDeduplicationKey(t.task) === key)) {
		return;
	}

	await ctx.db.insert("workerTasks", {
		task,
		status: "Pending",
		createdAt: Date.now(),
	});
}

/**
 * Enqueue DialogSync + UpdateListener for a newly-Connected client.
 * Called whenever a client transitions to Connected status.
 */
export async function enqueueClientStart(
	ctx: MutationCtx,
	client: Doc<"clients">,
): Promise<void> {
	const base = {
		clientId: client._id,
		userId: client.userId,
		telegramId: client.telegramId,
	};
	await enqueueTask(ctx, { type: "DialogSync:sync", ...base });
	await enqueueTask(ctx, { type: "UpdateListener:listen", ...base });
}

/**
 * Enqueue stop handlers for all services of a disconnecting client.
 * MediaDownloader has no stop — per-file downloads are short-lived.
 */
export async function enqueueClientStop(
	ctx: MutationCtx,
	clientId: Id<"clients">,
): Promise<void> {
	await enqueueTask(ctx, { type: "UpdateListener:stop", clientId });
	await enqueueTask(ctx, { type: "ProfilePhotoSync:stop", clientId });
}
