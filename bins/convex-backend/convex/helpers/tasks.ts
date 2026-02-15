import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Enqueue a worker task with deduplication.
 *
 * Checks the `by_service_key_status` index for an existing Pending or
 * Dispatched task with the same (service, handler, key) before inserting.
 * If one already exists the call is a no-op.
 */
export async function enqueueTask(
	ctx: MutationCtx,
	service: string,
	handler: string,
	key: string,
	payload?: string,
): Promise<void> {
	// Dedup: skip if a Pending task already exists for the same service+key
	const existingPending = await ctx.db
		.query("workerTasks")
		.withIndex("by_service_key_status", (q) =>
			q.eq("service", service).eq("key", key).eq("status", "Pending"),
		)
		.first();
	if (existingPending && existingPending.handler === handler) return;

	// Dedup: also skip if a Dispatched (in-flight) task exists
	const existingDispatched = await ctx.db
		.query("workerTasks")
		.withIndex("by_service_key_status", (q) =>
			q.eq("service", service).eq("key", key).eq("status", "Dispatched"),
		)
		.first();
	if (existingDispatched && existingDispatched.handler === handler) return;

	await ctx.db.insert("workerTasks", {
		service,
		handler,
		key,
		payload,
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
	const payload = JSON.stringify(client);
	await enqueueTask(ctx, "DialogSync", "sync", client._id, payload);
	await enqueueTask(ctx, "UpdateListener", "listen", client._id, payload);
}

/**
 * Enqueue stop handlers for all services of a disconnecting client.
 */
export async function enqueueClientStop(
	ctx: MutationCtx,
	clientId: Id<"clients">,
): Promise<void> {
	await enqueueTask(ctx, "UpdateListener", "stop", clientId);
	await enqueueTask(ctx, "ProfilePhotoSync", "stop", clientId);
	await enqueueTask(ctx, "MediaDownloader", "stop", clientId);
}
