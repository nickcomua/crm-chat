import { useCallback, useEffect, useState } from "react";
import type { Infer } from "spacetimedb";
import { useReducer, useTable } from "spacetimedb/react";
import { type Task, type TaskPayload, reducers, tables } from "../lib/spacetime";

type TaskType = Infer<typeof Task>;
type TaskPayloadType = Infer<typeof TaskPayload>;

interface UseTaskOptions {
  /** Auto-cleanup task when component unmounts */
  autoCleanup?: boolean;
}

interface UseTaskReturn<T extends TaskPayloadType> {
  /** The current task, if any */
  task: TaskType | null;
  /** Whether a task is currently active */
  isActive: boolean;
  /** Create a new task with the given payload */
  createTask: (payload: T) => void;
  /** Cancel the current task */
  cancelTask: () => void;
  /** Get the typed payload from the task */
  getPayload: () => T | null;
}

/**
 * Hook for managing SpacetimeDB tasks with typed payloads.
 * 
 * @param taskTag - The tag of the task payload type (e.g., "GenerateQrCode")
 * @param options - Configuration options
 */
export function useTask<T extends TaskPayloadType>(
  taskTag: T["tag"],
  options: UseTaskOptions = {}
): UseTaskReturn<T> {
  const { autoCleanup = true } = options;
  
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tasks] = useTable(tables.task);
  const createTaskReducer = useReducer(reducers.createTask);
  const cancelTaskReducer = useReducer(reducers.cancelTask);

  // Find our task by ID
  const task = taskId ? tasks.find((t) => t.id === taskId) ?? null : null;
  
  // Check if task is active (not Done)
  const isActive = task !== null && task.status.tag !== "Done";

  // Create a new task
  const createTask = useCallback(
    (payload: T) => {
      const id = crypto.randomUUID();
      setTaskId(id);
      createTaskReducer({ id, payload });
    },
    [createTaskReducer]
  );

  // Cancel the current task
  const cancelTask = useCallback(() => {
    if (taskId) {
      cancelTaskReducer({ taskId });
      setTaskId(null);
    }
  }, [taskId, cancelTaskReducer]);

  // Get typed payload
  const getPayload = useCallback((): T | null => {
    if (!task || task.payload.tag !== taskTag) return null;
    return task.payload as T;
  }, [task, taskTag]);

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
    createTask,
    cancelTask,
    getPayload,
  };
}
