import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { workerTask } from "../schema";

type WorkerTask = Infer<typeof workerTask>;

/**
 * Extract a deduplication key from a typed worker task.
 * Tasks with the same (type, dedupKey) are considered duplicates.
 */
export function getDeduplicationKey(task: WorkerTask): string {
  switch (task.type) {
    case "PhoneAuth":
      return task.authId;

    // QrAuth is inserted directly — never goes through enqueueTask
    case "QrAuth":
      throw new Error("QrAuth tasks bypass enqueueTask");

    case "DialogSync":
    case "UpdateListener":
    case "ProfilePhotoSync":
      return task.clientId;

    case "ChatScanner":
      return task.chatId;

    case "MediaDownloader":
      return task.telegramFileId;

    default:
      throw new Error(`Unknown task type: ${(task as WorkerTask).type}`);
  }
}

/**
 * Enqueue a typed worker task with deduplication.
 *
 * Checks for an existing Pending, Dispatched, or Running task with the same
 * (type, dedupKey) before inserting. If one already exists, this is a no-op.
 *
 * Uses `by_status` index + in-memory filtering since the workerTasks table
 * only contains active (Pending/Dispatched/Running) rows — always small.
 */
export async function enqueueTask(
  ctx: MutationCtx,
  task: WorkerTask
): Promise<void> {
  const key = getDeduplicationKey(task);

  for (const status of ["Pending", "Dispatched", "Running"] as const) {
    const tasks = await ctx.db
      .query("workerTasks")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    if (
      tasks.some(
        (t) => t.task.type === task.type && getDeduplicationKey(t.task) === key
      )
    ) {
      return;
    }
  }

  await ctx.db.insert("workerTasks", {
    task,
    status: "Pending",
    createdAt: Date.now(),
  });
}

/**
 * Cancel all active tasks for a disconnecting client.
 * Patches Pending/Dispatched/Running tasks with a matching clientId to Cancelled.
 */
// TODO you should able to cansel only Running tasks beacose
// for Dispatched you should canse it only via restate
// for Pending just delete
export async function cancelClientTasks(
  ctx: MutationCtx,
  clientId: Id<"clients">
): Promise<void> {
  for (const status of ["Running", "Dispatched", "Pending"] as const) {
    const tasks = await ctx.db
      .query("workerTasks")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    for (const task of tasks) {
      if ("clientId" in task.task && task.task.clientId === clientId) {
        await ctx.db.patch(task._id, { status: "Cancelled" });
      }
    }
  }
}
