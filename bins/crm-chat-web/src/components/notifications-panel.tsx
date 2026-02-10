import { useMutation, useQuery } from "convex/react";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { api } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

type Severity = "Info" | "Warning" | "Error";

function getSeverityIcon(severity: Severity): React.ReactNode {
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

function getSeverityBorderColor(severity: Severity): string {
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
  const notifications = useQuery(api.notifications.list);
  const dismiss = useMutation(api.notifications.dismiss);

  if (notifications === undefined) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground text-xs">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {notifications.length === 0 ? (
        <p className="text-muted-foreground text-xs">No notifications</p>
      ) : (
        <div className="space-y-2">
          {notifications.map(
            (notification: {
              _id: string;
              severity: Severity;
              message: string;
            }) => (
              <div
                className={cn(
                  "flex items-start gap-3 rounded-md border border-l-4 bg-card p-3",
                  getSeverityBorderColor(notification.severity)
                )}
                key={notification._id}
              >
                <div className="shrink-0 pt-0.5">
                  {getSeverityIcon(notification.severity)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{notification.message}</p>
                </div>
                <Button
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => dismiss({ notificationId: notification._id })}
                  size="icon"
                  variant="ghost"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
