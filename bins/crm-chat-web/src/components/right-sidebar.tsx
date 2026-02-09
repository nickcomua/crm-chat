import { Bell, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/lib/spacetime";
import { NotificationsPanel } from "./notifications-panel";
import { Button } from "./ui/button";

export function RightSidebar(): React.ReactNode {
  const [isOpen, setIsOpen] = useState(true);
  const [notifications] = useTable(tables.notification);

  const pendingCount = notifications.filter((n) => !n.dismissed).length;

  return (
    <>
      {/* Collapsed state - just show toggle button */}
      {!isOpen && (
        <div className="flex h-full flex-col border-l bg-background">
          <div className="flex flex-col items-center gap-2 p-2">
            <Button
              className="relative"
              onClick={() => setIsOpen(true)}
              size="icon"
              title="Open notifications"
              variant="ghost"
            >
              <PanelRightOpen className="h-5 w-5" />
              {pendingCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive font-medium text-destructive-foreground text-xs">
                  {pendingCount > 9 ? "9+" : pendingCount}
                </span>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Expanded state - full sidebar */}
      {isOpen && (
        <div className="flex h-full w-80 flex-col border-l bg-card/50">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              <h2 className="font-display font-semibold text-sm">
                Notifications
              </h2>
              {pendingCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-medium text-primary-foreground text-xs">
                  {pendingCount}
                </span>
              )}
            </div>
            <Button
              onClick={() => setIsOpen(false)}
              size="icon"
              title="Close notifications"
              variant="ghost"
            >
              <PanelRightClose className="h-5 w-5" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <NotificationsPanel />
          </div>
        </div>
      )}
    </>
  );
}
