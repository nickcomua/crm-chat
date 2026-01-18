import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import { MessageSquare, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DbConnectionBuilder, Identity } from "spacetimedb";
import { SpacetimeDBProvider } from "spacetimedb/react";

import { ChatPage } from "./components/chat-page";
import { TelegramClientsManager } from "./components/telegram-clients-manager";
import { Button } from "./components/ui/button";
import { env } from "./env";
import { useTheme } from "./hooks/use-theme";
import { DbConnection, type ErrorContext } from "./lib/spacetime";
import { cn } from "./lib/utils";

function App() {
  return (
    <div className="min-h-screen bg-background">
      <SignedOut>
        <LoginPage />
      </SignedOut>
      <SignedIn>
        <Dashboard />
      </SignedIn>
    </div>
  );
}

function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 px-4">
        <div className="text-center">
          <h1 className="font-bold text-4xl text-foreground tracking-tight">
            CRM Chat
          </h1>
          <p className="mt-2 text-muted-foreground">
            Manage your Telegram clients
          </p>
        </div>
        <div className="flex flex-col gap-4">
          <SignInButton mode="modal">
            <button
              className="w-full rounded-lg bg-primary px-4 py-3 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
              type="button"
            >
              Sign In
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button
              className="w-full rounded-lg border border-input bg-background px-4 py-3 font-medium text-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              type="button"
            >
              Create Account
            </button>
          </SignUpButton>
        </div>
      </div>
    </div>
  );
}

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

type ConnectionState =
  | { status: "loading" }
  | { status: "ready"; builder: DbConnectionBuilder<DbConnection> }
  | { status: "error"; message: string };

function Dashboard() {
  const { getToken, isLoaded } = useAuth();
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: "loading",
  });
  const [connectionKey, setConnectionKey] = useState(0);
  const [activeTab, setActiveTab] = useState<"chats" | "settings">("chats");
  const retryCountRef = useRef(0);
  const connectionBuilderRef = useRef<DbConnectionBuilder<DbConnection> | null>(
    null
  );
  const maxRetries = 3;

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
      console.log(
        "Connected to SpacetimeDB with identity:",
        identity.toHexString()
      );
      retryCountRef.current = 0;
    };

    const onDisconnect = () => {
      console.log("Disconnected from SpacetimeDB");
    };

    const handleTokenRetry = async (
      onConnectError: (ctx: ErrorContext, err: Error | Event) => Promise<void>
    ) => {
      retryCountRef.current += 1;
      console.log(
        `Token error detected, refreshing token (attempt ${retryCountRef.current}/${maxRetries})...`
      );

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
                <button
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    activeTab === "chats"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  onClick={() => setActiveTab("chats")}
                  type="button"
                >
                  <MessageSquare className="h-4 w-4" />
                  Chats
                </button>
                <button
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    activeTab === "settings"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  onClick={() => setActiveTab("settings")}
                  type="button"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </button>
              </nav>
            </div>
            <div className="flex items-center gap-2">
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
        <main className="flex-1 overflow-hidden">
          {activeTab === "chats" ? (
            <ChatPage />
          ) : (
            <div className="container px-4 py-8">
              <TelegramClientsManager />
            </div>
          )}
        </main>
      </div>
    </SpacetimeDBProvider>
  );
}

export default App;
