import { useMutation, useQuery } from "convex/react";
import { AlertCircle, AlertTriangle, Bell, Info, X } from "lucide-react";
import { api, type Id } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

type Severity = "Info" | "Warning" | "Error";

function getSeverityIcon(severity: Severity): React.ReactNode {
  switch (severity) {
    case "Error":
      return <AlertCircle className="h-4 w-4 text-destructive" />;
    case "Warning":
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case "Info":
      return <Info className="h-4 w-4 text-blue-500" />;
    default:
      return <Info className="h-4 w-4 text-muted-foreground" />;
  }
}

function getSeverityAccent(severity: Severity): string {
  switch (severity) {
    case "Error":
      return "border-l-destructive/60";
    case "Warning":
      return "border-l-amber-500/60";
    case "Info":
      return "border-l-blue-500/60";
    default:
      return "border-l-muted-foreground/40";
  }
}

export function NotificationsPanel(): React.ReactNode {
  const notifications = useQuery(api.notifications.list);
  const dismiss = useMutation(api.notifications.dismiss);

  if (notifications === undefined) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  return (
    <div className="p-3">
      {notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Bell className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <p className="font-medium text-muted-foreground/50 text-xs">
            All caught up
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {notifications.map(
            (notification: {
              _id: Id<"notifications">;
              severity: Severity;
              message: string;
            }) => (
              <div
                className={cn(
                  "group flex items-start gap-2.5 rounded-lg border border-l-[3px] bg-card/60 p-2.5 transition-colors hover:bg-card",
                  getSeverityAccent(notification.severity)
                )}
                key={notification._id}
              >
                <div className="shrink-0 pt-px">
                  {getSeverityIcon(notification.severity)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-relaxed">
                    {notification.message}
                  </p>
                </div>
                <Button
                  className="h-6 w-6 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  onClick={() => dismiss({ notificationId: notification._id })}
                  size="icon"
                  variant="ghost"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
