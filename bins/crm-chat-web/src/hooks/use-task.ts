import { useEffect, useState } from "react";
import type { Infer } from "spacetimedb";
import { useReducer, useTable } from "spacetimedb/react";
import {
  reducers,
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

export function useTask<T extends TaskPayloadType>({
  id,
}: {
  id: string | undefined;
}): {
  createTask: (id: string, payload: T) => void;
  completeTask: (payload: T) => void;
  cancelTask: () => void;
  task: TaskWithPayload<T> | undefined;
} {
  const [taskId, setTaskId] = useState<string | undefined>(id);
  useEffect(() => {
    setTaskId(id);
  }, [id]);
  const cancelTaskReducer = useReducer(reducers.cancelTask);
  const completeTaskReducer = useReducer(reducers.completeTask);
  const createTaskReducer = useReducer(reducers.createTask);
  const [tasks] = useTable(tables.task);
  const task = taskId
    ? (tasks.find((t) => t.id === taskId) as TaskWithPayload<T> | undefined)
    : undefined;

  const createTask = (id: string, payload: T) => {
    createTaskReducer({ id, payload });
    setTaskId(id);
  };
  const cancelTask = () => {
    if (taskId) {
      cancelTaskReducer({ taskId });
    }
  };
  const completeTask = (payload: T) => {
    if (!taskId) {
      throw new Error("No task to complete");
    }
    completeTaskReducer({ taskId, payload });
  };
  // Cancel task on unmount
  useEffect(() => {
    return () => {
      cancelTask();
    };
  }, [cancelTask]);

  return { task, createTask, completeTask, cancelTask };
}
