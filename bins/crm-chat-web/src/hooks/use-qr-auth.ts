import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api, type Doc, type Id } from "@/lib/convex";

type QrAuthTask = Extract<Doc<"workerTasks">["task"], { type: "QrAuth" }>;

export interface QrAuthProgress {
  step: QrAuthTask["step"];
  qrUrl: string | undefined;
  qrExpires: number | undefined;
  error: string | undefined;
}

function isTerminalStep(step: QrAuthTask["step"]): boolean {
  return (
    step === "Authorized" ||
    step === "AlreadyAuthorized" ||
    step === "Failed" ||
    step === "Cancelled"
  );
}

interface UseQrAuthReturn {
  /** Current progress, or null if task doesn't exist / was deleted */
  progress: QrAuthProgress | null;
  /** True when the task existed but was deleted (auth flow finished) */
  isDone: boolean;
  /** Start a new QR auth session */
  startQrAuth: () => void;
  /** Cancel the active QR auth session */
  cancelQrAuth: () => void;
}

/**
 * Extract QR auth progress from a workerTask doc.
 * Returns null if the task is not a QrAuth task.
 */
function extractProgress(
  task: Doc<"workerTasks"> | null | undefined
): QrAuthProgress | null {
  if (!task || task.task.type !== "QrAuth") {
    return null;
  }
  return {
    step: task.task.step,
    qrUrl: task.task.qrUrl,
    qrExpires: task.task.qrExpires,
    error: task.task.error,
  };
}

/**
 * Hook for managing QR auth sessions via the workerTasks table.
 */
export function useQrAuth(): UseQrAuthReturn {
  const [taskId, setTaskId] = useState<Id<"workerTasks"> | null>(null);
  const startMutation = useMutation(api.qrAuth.start);
  const cancelMutation = useMutation(api.qrAuth.cancel);

  // Subscribe to the full task doc (skip when no taskId)
  const queryResult = useQuery(
    api.workerTasks.getTaskById,
    taskId ? { taskId } : "skip"
  );

  const progress = extractProgress(queryResult);

  // isDone = we started a task (taskId set) AND the query returned null
  // (not undefined/loading, but explicitly null = task deleted)
  const isDone = taskId !== null && queryResult === null;

  const startQrAuth = (): void => {
    setTaskId(null);
    startMutation({}).then(
      (id) => setTaskId(id),
      (error) => console.error("[qrAuth.start]", error)
    );
  };

  const cancelQrAuth = (): void => {
    if (taskId && progress && !isTerminalStep(progress.step)) {
      cancelMutation({ taskId });
    }
  };

  return { progress, isDone, startQrAuth, cancelQrAuth };
}
