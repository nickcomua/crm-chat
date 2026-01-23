import { SignedIn, SignedOut, UserButton, useAuth } from "@clerk/clerk-react";
import {
  createFileRoute,
  Link,
  Navigate,
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
  return (
    <>
      <SignedOut>
        <Navigate to="/" />
      </SignedOut>
      <SignedIn>
        <AuthenticatedContent />
      </SignedIn>
    </>
  );
}

function AuthenticatedContent(): React.ReactNode {
  const { getToken, isLoaded } = useAuth();
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
    if (!isLoaded) {
      return;
    }

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

    const handleTokenRetry = async (
      onConnectError: (ctx: ErrorContext, err: Error | Event) => Promise<void>
    ) => {
      retryCountRef.current += 1;
      if (import.meta.env.DEV) {
        console.log(
          `Token error detected, refreshing token (attempt ${retryCountRef.current}/${maxRetries})...`
        );
      }

      try {
        const newToken = await getToken({ skipCache: true });
        if (cancelled) {
          return;
        }

        const newBuilder = DbConnection.builder()
          .withUri(env.VITE_SPACETIMEDB_HOST)
          .withModuleName(env.VITE_SPACETIMEDB_MODULE)
          .withToken(newToken ?? undefined)
          .onConnect(onConnect)
          .onDisconnect(onDisconnect)
          .onConnectError(onConnectError);

        connectionBuilderRef.current = newBuilder;
        setConnectionState({ status: "ready", builder: newBuilder });
        setConnectionKey((k) => k + 1);
      } catch {
        if (!cancelled) {
          setConnectionState({
            status: "error",
            message:
              "Failed to refresh authentication. Please refresh the page.",
          });
        }
      }
    };

    const isTokenRelatedError = (err: Error | Event): boolean => {
      if (err instanceof Event) {
        return false;
      }
      const errorMessage =
        (err as Error & { message?: string })?.message?.toLowerCase() ?? "";
      return (
        errorMessage.includes("token") ||
        errorMessage.includes("auth") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("401")
      );
    };

    const onConnectError = async (_ctx: ErrorContext, err: Error | Event) => {
      console.error("Error connecting to SpacetimeDB:", err);

      if (err instanceof Event) {
        return;
      }

      const isTokenError = isTokenRelatedError(err);
      const errorMessage =
        (err as Error & { message?: string })?.message?.toLowerCase() ??
        "unknown error";

      if (isTokenError && retryCountRef.current < maxRetries) {
        await handleTokenRetry(onConnectError);
      } else if (!cancelled) {
        setConnectionState({
          status: "error",
          message: isTokenError
            ? "Failed to authenticate after multiple attempts. Please refresh the page."
            : `Connection error: ${errorMessage}`,
        });
      }
    };

    const initConnection = async () => {
      try {
        const authToken = await getToken({ skipCache: true });

        if (cancelled) {
          return;
        }

        const builder = DbConnection.builder()
          .withUri(env.VITE_SPACETIMEDB_HOST)
          .withModuleName(env.VITE_SPACETIMEDB_MODULE)
          .withToken(authToken ?? undefined)
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
            message: "Failed to get authentication token",
          });
        }
      }
    };

    initConnection();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, getToken]);

  if (!isLoaded || connectionState.status === "loading") {
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
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: "h-9 w-9",
                  },
                }}
              />
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
