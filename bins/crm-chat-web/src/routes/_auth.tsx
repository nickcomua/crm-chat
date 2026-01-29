import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { MessageSquare, Moon, Search, Settings, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DbConnectionBuilder, Identity } from "spacetimedb";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { RightSidebar } from "@/components/right-sidebar";
import { SearchDialog } from "@/components/search-dialog";
import { Button } from "@/components/ui/button";
import { env } from "@/env";
import { useTheme } from "@/hooks/use-theme";
import { DbConnection, type ErrorContext } from "@/lib/spacetime";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
});

type ConnectionState =
  | { status: "loading" }
  | { status: "ready"; builder: DbConnectionBuilder<DbConnection> }
  | { status: "error"; message: string };

function ThemeToggle(): React.ReactNode {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      size="icon"
      variant="ghost"
    >
      {resolvedTheme === "dark" ? (
        <Sun className="h-5 w-5" />
      ) : (
        <Moon className="h-5 w-5" />
      )}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}

function AuthLayout(): React.ReactNode {
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: "loading",
  });
  const [connectionKey, setConnectionKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const retryCountRef = useRef(0);
  const connectionBuilderRef = useRef<DbConnectionBuilder<DbConnection> | null>(
    null
  );
  const maxRetries = 3;

  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  useEffect(() => {
    let cancelled = false;

    const onConnect = (
      _conn: DbConnection,
      identity: Identity,
      token: string
    ) => {
      localStorage.setItem("auth_token", token);
      if (import.meta.env.DEV) {
        console.log(
          "Connected to SpacetimeDB with identity:",
          identity.toHexString()
        );
      }
      retryCountRef.current = 0;
    };

    const onDisconnect = () => {
      if (import.meta.env.DEV) {
        console.log("Disconnected from SpacetimeDB");
      }
    };

    const onConnectError = async (_ctx: ErrorContext, err: Error | Event) => {
      console.error("Error connecting to SpacetimeDB:", err);

      if (err instanceof Event) {
        return;
      }

      // Check if it's a token validation error
      const errorMessage = (err as Error & { message?: string })?.message ?? "";
      if (errorMessage.includes("Unauthorized") || errorMessage.includes("verify token")) {
        // Clear invalid token and retry once
        if (localStorage.getItem("auth_token")) {
          console.log("Clearing invalid auth token and retrying...");
          localStorage.removeItem("auth_token");
          if (!cancelled) {
            setConnectionKey((k) => k + 1);
            return;
          }
        }
      }

      retryCountRef.current += 1;
      
      if (retryCountRef.current < maxRetries && !cancelled) {
        // Retry connection
        setTimeout(() => {
          if (!cancelled) {
            setConnectionKey((k) => k + 1);
          }
        }, 1000 * retryCountRef.current);
      } else if (!cancelled) {
        setConnectionState({
          status: "error",
          message: `Connection error: ${errorMessage}`,
        });
      }
    };

    const initConnection = async () => {
      try {
        // Get stored token or use undefined to get a new identity
        const storedToken = localStorage.getItem("auth_token") || undefined;

        if (cancelled) {
          return;
        }

        const builder = DbConnection.builder()
          .withUri(env.VITE_SPACETIMEDB_HOST)
          .withModuleName(env.VITE_SPACETIMEDB_MODULE)
          .withToken(storedToken)
          .onConnect(onConnect)
          .onDisconnect(onDisconnect)
          .onConnectError(onConnectError);

        connectionBuilderRef.current = builder;
        setConnectionState({ status: "ready", builder });
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to initialize connection:", error);
          setConnectionState({
            status: "error",
            message: "Failed to initialize connection",
          });
        }
      }
    };

    initConnection();

    return () => {
      cancelled = true;
    };
  }, [connectionKey]);

  if (connectionState.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (connectionState.status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="text-destructive">{connectionState.message}</div>
          <button
            className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
            onClick={() => window.location.reload()}
            type="button"
          >
            Refresh Page
          </button>
        </div>
      </div>
    );
  }

  return (
    <SpacetimeDBProvider
      connectionBuilder={connectionState.builder}
      key={connectionKey}
    >
      <div className="flex h-screen flex-col">
        <header className="sticky top-0 z-50 border-border border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex h-14 items-center justify-between px-4">
            <div className="flex items-center gap-6">
              <h1 className="font-semibold text-xl">CRM Chat</h1>
              <nav className="flex items-center gap-1">
                <Link
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    currentPath.startsWith("/chats")
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  to="/chats"
                >
                  <MessageSquare className="h-4 w-4" />
                  Chats
                </Link>
                <Link
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    currentPath === "/settings"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  to="/settings"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </nav>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setSearchOpen(true)}
                size="icon"
                variant="ghost"
              >
                <Search className="h-5 w-5" />
                <span className="sr-only">Search messages</span>
              </Button>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-hidden">
            <Outlet />
          </main>
          <RightSidebar />
        </div>
      </div>
      <SearchDialog
        onOpenChange={setSearchOpen}
        onSelectResult={(result) => {
          navigate({
            to: "/chats/$chatId",
            params: { chatId: result.chatId },
          });
        }}
        open={searchOpen}
      />
    </SpacetimeDBProvider>
  );
}
