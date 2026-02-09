import { RedirectToSignIn, UserButton, useAuth } from "@clerk/clerk-react";
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
import { SpacetimeDBProvider, useSpacetimeDB } from "spacetimedb/react";
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
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}

/**
 * Workaround for SpacetimeDB SDK v1.10.0 bug: useTable accesses
 * connection.db[table.name] (snake_case) but connection.db is keyed by
 * accessorName (camelCase). This adds snake_case aliases so tables like
 * qr_auth and phone_auth resolve correctly.
 */
function DbPatcher({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const { getConnection } = useSpacetimeDB();
  const conn = getConnection();
  if (conn) {
    const db = conn.db as Record<string, unknown>;
    for (const key of Object.keys(db)) {
      const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
      if (snakeKey !== key && !(snakeKey in db)) {
        Object.defineProperty(db, snakeKey, {
          get() {
            return db[key];
          },
          enumerable: false,
        });
      }
    }
  }
  return children;
}

function AuthLayout(): React.ReactNode {
  const { isLoaded, isSignedIn, getToken } = useAuth();
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
      conn: DbConnection,
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

      conn
        .subscriptionBuilder()
        .subscribe([
          "SELECT * FROM client",
          "SELECT * FROM chat",
          "SELECT * FROM message",
          "SELECT * FROM human",
          "SELECT * FROM notification",
          "SELECT * FROM qr_auth",
          "SELECT * FROM phone_auth",
        ]);
    };

    const onDisconnect = () => {
      if (import.meta.env.DEV) {
        console.log("Disconnected from SpacetimeDB");
      }
    };

    const onConnectError = (_ctx: ErrorContext, err: Error | Event): void => {
      console.error("Error connecting to SpacetimeDB:", err);

      if (err instanceof Event) {
        return;
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
        const errorMessage =
          (err as Error & { message?: string })?.message ?? "unknown error";
        setConnectionState({
          status: "error",
          message: `Connection error: ${errorMessage}`,
        });
      }
    };

    const initConnection = async () => {
      try {
        // Wait for Clerk to load
        if (!isLoaded) {
          return;
        }

        // Get Clerk session token for SpacetimeDB auth
        let token: string | undefined;
        if (isSignedIn) {
          // Use Clerk JWT for authenticated users
          token = (await getToken()) ?? undefined;
        } else {
          // Fall back to stored token for anonymous/returning users
          token = localStorage.getItem("auth_token") ?? undefined;
        }

        if (cancelled) {
          return;
        }

        const builder = DbConnection.builder()
          .withUri(env.VITE_SPACETIMEDB_HOST)
          .withModuleName(env.VITE_SPACETIMEDB_MODULE)
          .withToken(token)
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
  }, [connectionKey, isLoaded, isSignedIn, getToken]);

  // Wait for Clerk to load
  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
          <span className="font-display text-muted-foreground text-sm">
            Loading...
          </span>
        </div>
      </div>
    );
  }

  // Require sign-in
  if (!isSignedIn) {
    return <RedirectToSignIn />;
  }

  if (connectionState.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
          <span className="font-display text-muted-foreground text-sm">
            Connecting...
          </span>
        </div>
      </div>
    );
  }

  if (connectionState.status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="text-destructive text-sm">
            {connectionState.message}
          </div>
          <button
            className="rounded-lg bg-primary px-4 py-2 font-display font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
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
      <DbPatcher>
        <div className="flex h-screen flex-col">
          <header className="sticky top-0 z-50 border-border/50 border-b bg-background/80 backdrop-blur-xl">
            <div className="flex h-14 items-center justify-between px-4">
              <div className="flex items-center gap-5">
                <h1 className="font-display font-semibold text-lg tracking-tight">
                  CRM Chat
                </h1>
                <div className="hidden h-5 w-px bg-border sm:block" />
                <nav className="flex items-center gap-0.5">
                  <Link
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-1.5 font-medium text-sm transition-all",
                      currentPath.startsWith("/chats")
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    to="/chats"
                  >
                    <MessageSquare className="h-4 w-4" />
                    <span className="hidden sm:inline">Chats</span>
                  </Link>
                  <Link
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-1.5 font-medium text-sm transition-all",
                      currentPath === "/settings"
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    to="/settings"
                  >
                    <Settings className="h-4 w-4" />
                    <span className="hidden sm:inline">Settings</span>
                  </Link>
                </nav>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  onClick={() => setSearchOpen(true)}
                  size="icon"
                  variant="ghost"
                >
                  <Search className="h-4 w-4" />
                  <span className="sr-only">Search messages</span>
                </Button>
                <ThemeToggle />
                <div className="ml-1 h-5 w-px bg-border" />
                <div className="ml-1">
                  <UserButton
                    appearance={{
                      elements: {
                        avatarBox: "h-7 w-7",
                      },
                    }}
                  />
                </div>
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
      </DbPatcher>
    </SpacetimeDBProvider>
  );
}
