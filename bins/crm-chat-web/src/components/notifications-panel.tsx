import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import type { Infer } from "spacetimedb";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import {
  type DbConnection,
  type Task,
  TaskPayload,
  tables,
} from "@/lib/spacetime";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

type TaskType = Infer<typeof Task>;

type DisplayMessagePayload = Extract<
  Infer<typeof TaskPayload>,
  { tag: "DisplayMessage" }
>["value"];

function getDisplayMessageTasks(
  tasks: readonly TaskType[]
): Array<{ task: TaskType; message: DisplayMessagePayload }> {
  const result: Array<{ task: TaskType; message: DisplayMessagePayload }> = [];
  for (const task of tasks) {
    if (task.payload.tag === "DisplayMessage") {
      const message = task.payload.value;
      // Only show pending messages
      if (message.output.tag === "Pending") {
        result.push({ task, message });
      }
    }
  }
  return result;
}

function getSeverityIcon(
  severity: DisplayMessagePayload["severity"]["tag"]
): React.ReactNode {
  switch (severity) {
    case "Error":
      return <AlertCircle className="h-5 w-5 text-destructive" />;
    case "Warning":
      return <AlertTriangle className="h-5 w-5 text-amber-500" />;
    case "Info":
      return <Info className="h-5 w-5 text-blue-500" />;
    default:
      return <Info className="h-5 w-5 text-muted-foreground" />;
  }
}

function getSeverityBorderColor(
  severity: DisplayMessagePayload["severity"]["tag"]
): string {
  switch (severity) {
    case "Error":
      return "border-l-destructive";
    case "Warning":
      return "border-l-amber-500";
    case "Info":
      return "border-l-blue-500";
    default:
      return "border-l-muted-foreground";
  }
}

export function NotificationsPanel(): React.ReactNode {
  const { getConnection, isActive } = useSpacetimeDB();
  const conn = getConnection<DbConnection>();
  const [tasks] = useTable(tables.task);

  const notifications = getDisplayMessageTasks(tasks);

  if (import.meta.env.DEV) {
    console.log({ notificationsTasks: tasks, notifications });
  }

  const handleDismiss = (
    taskId: string,
    message: DisplayMessagePayload
  ): void => {
    if (!conn) {
      return;
    }
    // Complete the task with Dismissed output
    conn.reducers.completeTask({
      taskId,
      payload: TaskPayload.DisplayMessage({
        severity: message.severity,
        message: message.message,
        output: { tag: "Dismissed" },
      }),
    });
  };

  if (!isActive) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground text-xs">Connecting...</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {notifications.length === 0 ? (
        <p className="text-muted-foreground text-xs">No notifications</p>
      ) : (
        <div className="space-y-2">
          {notifications.map(({ task, message }) => (
            <div
              className={cn(
                "flex items-start gap-3 rounded-md border border-l-4 bg-card p-3",
                getSeverityBorderColor(message.severity.tag)
              )}
              key={task.id}
            >
              <div className="flex-shrink-0 pt-0.5">
                {getSeverityIcon(message.severity.tag)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{message.message}</p>
              </div>
              <Button
                className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => handleDismiss(task.id, message)}
                size="icon"
                variant="ghost"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
