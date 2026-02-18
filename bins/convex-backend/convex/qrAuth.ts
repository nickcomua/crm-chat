import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { isQrAuthTerminal, requireHuman, sendError } from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueTask } from "./helpers/tasks";

// =============================================================================
// Human Mutations
// =============================================================================

/** Start QR code authentication. Returns the task ID for subscription. */
export const start = mutation({
  args: {},
  returns: result(v.id("workerTasks")),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const taskId = await ctx.db.insert("workerTasks", {
      task: {
        type: "QrAuth" as const,
        step: "Pending" as const,
      },
      status: "Pending" as const,
      createdAt: Date.now(),
      userId: caller.id,
    });
    return ok(taskId);
  },
});

/** User cancels the QR auth flow. Worker detects via status subscription. */
export const cancel = mutation({
  args: { taskId: v.id("workerTasks") },
  returns: result(v.null()),
  handler: async (ctx, { taskId }) => {
    const caller = await requireHuman(ctx);
    const task = await ctx.db.get(taskId);
    if (!task) return err("Task not found");
    if (task.userId !== caller.id) return err("Unauthorized");
    if (task.task.type !== "QrAuth") return err("Not a QR auth task");

    if (isQrAuthTerminal(task.task.step)) {
      return err("Cannot cancel: auth is already in a terminal state");
    }

    // Patch both the task step and the universal status — worker detects via subscription
    await ctx.db.patch(taskId, {
      task: { ...task.task, step: "Cancelled" as const },
      status: "Cancelled" as const,
    });

    return ok(null);
  },
});

// =============================================================================
// Completion logic (called from workerTasks.workerComplete)
// =============================================================================

interface QrAuthTask {
	type: "QrAuth";
	step: string;
	telegramUserId?: bigint;
	phoneNumber?: string;
	error?: string;
}

export async function completeQrAuth(
	ctx: MutationCtx,
	ownerUserId: string | undefined,
	task: QrAuthTask,
): Promise<void> {
	if (!ownerUserId) throw new Error("QrAuth task has no userId");

	if (task.step === "Authorized" || task.step === "AlreadyAuthorized") {
		if (!task.telegramUserId) throw new Error("QrAuth completion requires telegramUserId");
		const telegramId = `telegram:${task.telegramUserId}`;

		const existing = await ctx.db
			.query("clients")
			.withIndex("by_userId_telegramId", (q) =>
				q.eq("userId", ownerUserId).eq("telegramId", telegramId),
			)
			.unique();

		let clientId: Id<"clients">;
		if (existing) {
			await ctx.db.patch(existing._id, {
				status: { type: "Connected" },
				...(task.phoneNumber ? { phoneNumber: task.phoneNumber } : {}),
			});
			clientId = existing._id;
		} else {
			clientId = await ctx.db.insert("clients", {
				userId: ownerUserId,
				kind: "Telegram",
				telegramId,
				phoneNumber: task.phoneNumber,
				scanningChatIds: [],
				status: { type: "Connected" },
			});
		}

		await enqueueTask(ctx, {
			type: "UpdateListener",
			clientId,
			userId: ownerUserId,
			telegramId,
		});
	} else if (task.step === "Failed") {
		await sendError(ctx, ownerUserId, `QR code login failed: ${task.error ?? "unknown error"}`);
	}
}

