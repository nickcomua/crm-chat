import { useCallback, useEffect, useState } from "react";
import type { Infer } from "spacetimedb";
import { useReducer, useTable } from "spacetimedb/react";
import {
  reducers,
  type Task,
  type TaskPayload,
  tables,
} from "../lib/spacetime";

type TaskType = Infer<typeof Task>;
type TaskPayloadType = Infer<typeof TaskPayload>;

interface UseTaskOptions {
  /** Auto-cleanup task when component unmounts */
  autoCleanup?: boolean;
}

interface UseTaskReturn {
  /** The current task, if any */
  task: TaskType | null;
  /** Whether a task is currently active */
  isActive: boolean;
  /** Start a new QR auth task */
  startQrAuth: () => void;
  /** Cancel the current task */
  cancelTask: () => void;
  /** Get the typed payload from the task */
  getPayload: <T extends TaskPayloadType>() => T | null;
}

/**
 * Hook for managing SpacetimeDB QR auth tasks.
 *
 * @param options - Configuration options
 */
export function useQrAuthTask(options: UseTaskOptions = {}): UseTaskReturn {
  const { autoCleanup = true } = options;

  const [taskId, setTaskId] = useState<string | null>(null);
  const [tasks] = useTable(tables.task);
  const createQrAuthTask = useReducer(reducers.createQrAuthTask);
  const cancelTaskReducer = useReducer(reducers.cancelTask);

  // Find our task by ID
  const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;

  // Check if task is active (not Done)
  const isActive = task !== null && task.status.tag !== "Done";

  // Start a new QR auth task
  const startQrAuth = useCallback(() => {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    setTaskId(id);
    createQrAuthTask({ taskId: id });
  }, [createQrAuthTask]);

  // Cancel the current task
  const cancelTask = useCallback(() => {
    if (taskId) {
      cancelTaskReducer({ taskId });
      setTaskId(null);
    }
  }, [taskId, cancelTaskReducer]);

  // Get typed payload
  const getPayload = useCallback(<T extends TaskPayloadType>(): T | null => {
    if (!task) {
      return null;
    }
    return task.payload as T;
  }, [task]);

  // Auto-cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoCleanup && taskId) {
        // Cancel task on unmount if still active
        cancelTaskReducer({ taskId });
      }
    };
  }, [autoCleanup, taskId, cancelTaskReducer]);

  return {
    task,
    isActive,
    startQrAuth,
    cancelTask,
    getPayload,
  };
}
