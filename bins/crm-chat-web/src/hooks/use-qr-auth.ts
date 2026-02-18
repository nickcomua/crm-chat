import { useConvex, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api, type Id, type Result } from "@/lib/convex";

type QrAuthStep =
  | "Pending"
  | "Generating"
  | "Token"
  | "Authorized"
  | "AlreadyAuthorized"
  | "Failed"
  | "Cancelled";

export interface QrAuthProgress {
  step: QrAuthStep;
  qrUrl?: string;
  qrExpires?: number;
  error?: string;
}

function isTerminalStep(step: QrAuthStep): boolean {
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
  task: Record<string, unknown> | null
): QrAuthProgress | null {
  if (!task) {
    return null;
  }
  const inner = task.task as Record<string, unknown> | undefined;
  if (!inner || inner.type !== "QrAuth") {
    return null;
  }
  return {
    step: inner.step as QrAuthStep,
    qrUrl: inner.qrUrl as string | undefined,
    qrExpires: inner.qrExpires as number | undefined,
    error: inner.error as string | undefined,
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

  const progress = extractProgress(
    (queryResult as Record<string, unknown> | null | undefined) ?? null
  );

  // isDone = we started a task (taskId set) AND the query returned null
  // (not undefined/loading, but explicitly null = task deleted)
  const isDone = taskId !== null && queryResult === null;

  const startQrAuth = (): void => {
    setTaskId(null);
    startMutation({}).then((r: Result<Id<"workerTasks">>) => {
      if (r.ok) {
        setTaskId(r.value);
      } else {
        console.error("[qrAuth.start]", r.error);
      }
    });
  };

  const cancelQrAuth = (): void => {
    if (taskId && progress && !isTerminalStep(progress.step)) {
      cancelMutation({ taskId }).then((r: Result<null>) => {
        if (!r.ok) {
          console.error("[qrAuth.cancel]", r.error);
        }
      });
    }
  };

  // Cancel the QR auth task on page refresh/close via sendBeacon.
  // Presence cron is the safety net if this doesn't fire.
  const convex = useConvex();
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  useEffect(() => {
    const handleBeforeUnload = (): void => {
      const id = taskIdRef.current;
      if (!id) {
        return;
      }
      const blob = new Blob(
        [
          JSON.stringify({
            path: "workerTasks:cancelTask",
            args: { taskId: id },
          }),
        ],
        { type: "application/json" }
      );
      navigator.sendBeacon(`${convex.url}/api/mutation`, blob);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [convex.url]);

  return { progress, isDone, startQrAuth, cancelQrAuth };
}
