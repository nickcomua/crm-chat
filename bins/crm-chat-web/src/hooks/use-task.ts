import { useEffect, useRef, useState } from "react";
import type { Infer } from "spacetimedb";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import {
  type DbConnection,
  type Task,
  type TaskPayload,
  tables,
} from "../lib/spacetime";

// Union of all task payload types
export type TaskPayloadType = Infer<typeof TaskPayload>;

// Task with typed payload
export type TaskWithPayload<T extends TaskPayloadType = TaskPayloadType> = Omit<
  Infer<typeof Task>,
  "payload"
> & { payload: T };

/**
 * Hook for managing a single task.
 * TaskId is generated internally when createTask is called.
 *
 * @returns Object with createTask function, completeTask function, cancelTask function, and the current task
 */
export function useTask<T extends TaskPayloadType>(): {
  createTask: (payload: T) => string;
  completeTask: (payload: T) => void;
  cancelTask: () => void;
  task: TaskWithPayload<T> | undefined;
  taskId: string | null;
  resetTask: () => void;
} {
  const [taskId, setTaskId] = useState<string | null>(null);
  const { getConnection } = useSpacetimeDB();
  const conn = getConnection<DbConnection>();
  const [tasks] = useTable(tables.task);

  const task = taskId
    ? (tasks.find((t) => t.id === taskId) as TaskWithPayload<T> | undefined)
    : undefined;

  const createTask = (payload: T): string => {
    if (!conn) {
      throw new Error("No connection available");
    }
    const newTaskId = crypto.randomUUID();
    setTaskId(newTaskId);
    conn.reducers.createTask({ id: newTaskId, payload });
    return newTaskId;
  };

  const completeTask = (payload: T): void => {
    if (!taskId) {
      throw new Error("No task to complete");
    }
    if (!conn) {
      throw new Error("No connection available");
    }
    conn.reducers.completeTask({ taskId, payload });
  };

  const cancelTask = (): void => {
    if (!taskId) {
      return; // No task to cancel
    }
    if (!conn) {
      throw new Error("No connection available");
    }
    // cancelTask reducer may not exist yet - check before calling
    if ("cancelTask" in conn.reducers) {
      conn.reducers.cancelTask({ taskId });
    }
    setTaskId(null);
  };

  const resetTask = (): void => {
    setTaskId(null);
  };

  return { createTask, completeTask, cancelTask, task, taskId, resetTask };
}

/**
 * Hook for managing a task with automatic cancellation on unmount.
 * Use this for tasks that should be cancelled when the component is unmounted.
 */
export function useTaskWithCleanup<T extends TaskPayloadType>(): {
  createTask: (payload: T) => string;
  completeTask: (payload: T) => void;
  cancelTask: () => void;
  task: TaskWithPayload<T> | undefined;
  taskId: string | null;
  resetTask: () => void;
} {
  const taskHook = useTask<T>();
  const taskIdRef = useRef<string | null>(null);
  const connRef = useRef<DbConnection | null>(null);
  const { getConnection } = useSpacetimeDB();

  // Keep refs up to date
  taskIdRef.current = taskHook.taskId;
  connRef.current = getConnection<DbConnection>();

  // Cancel task on unmount
  useEffect(() => {
    return () => {
      const currentTaskId = taskIdRef.current;
      const conn = connRef.current;
      if (currentTaskId && conn && "cancelTask" in conn.reducers) {
        (
          conn.reducers as unknown as {
            cancelTask: (params: { taskId: string }) => void;
          }
        ).cancelTask({ taskId: currentTaskId });
      }
    };
  }, []);

  return taskHook;
}

/**
 * Hook to watch a task by its ID (for tasks created elsewhere, e.g., by the backend).
 */
export function useWatchTask<T extends TaskPayloadType>(
  taskId: string | null
): TaskWithPayload<T> | undefined {
  const [tasks] = useTable(tables.task);

  if (!taskId) {
    return undefined;
  }

  return tasks.find((t) => t.id === taskId) as TaskWithPayload<T> | undefined;
}
