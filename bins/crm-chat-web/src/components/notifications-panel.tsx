import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import type { Infer } from "spacetimedb";
import { useReducer, useSpacetimeDB, useTable } from "spacetimedb/react";
import {
  type MessageSeverity,
  type Notification,
  reducers,
  tables,
} from "@/lib/spacetime";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

type NotificationType = Infer<typeof Notification>;
type SeverityTag = Infer<typeof MessageSeverity>["tag"];

function getSeverityIcon(severity: SeverityTag): React.ReactNode {
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

function getSeverityBorderColor(severity: SeverityTag): string {
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
  const { isActive } = useSpacetimeDB();
  const [notifications] = useTable(tables.notification);
  const dismissNotification = useReducer(reducers.dismissNotification);

  const pendingNotifications = notifications.filter(
    (n: NotificationType) => !n.dismissed
  );

  if (!isActive) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground text-xs">Connecting...</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {pendingNotifications.length === 0 ? (
        <p className="text-muted-foreground text-xs">No notifications</p>
      ) : (
        <div className="space-y-2">
          {pendingNotifications.map((notification: NotificationType) => (
            <div
              className={cn(
                "flex items-start gap-3 rounded-md border border-l-4 bg-card p-3",
                getSeverityBorderColor(notification.severity.tag)
              )}
              key={notification.id.toString()}
            >
              <div className="flex-shrink-0 pt-0.5">
                {getSeverityIcon(notification.severity.tag)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{notification.message}</p>
              </div>
              <Button
                className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() =>
                  dismissNotification({ notificationId: notification.id })
                }
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
