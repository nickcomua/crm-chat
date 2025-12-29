import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect, useState } from "react";
import type { Identity } from "spacetimedb";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { TelegramClientsManager } from "./components/telegram-clients-manager";
import { env } from "./env";
import { DbConnection, type ErrorContext } from "./lib/spacetime";

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

const onConnect = (conn: DbConnection, identity: Identity, token: string) => {
  localStorage.setItem("auth_token", token);
  console.log(
    "Connected to SpacetimeDB with identity:",
    identity.toHexString()
  );
  conn.reducers.onUpsertClient((e) => {
    console.log("client updated.", e);
  });
};

const onDisconnect = () => {
  console.log("Disconnected from SpacetimeDB");
};

const onConnectError = (_ctx: ErrorContext, err: Error) => {
  console.log("Error connecting to SpacetimeDB:", err);
};

function Dashboard() {
  const { getToken, isLoaded } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [isLoadingToken, setIsLoadingToken] = useState(true);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    const fetchToken = async () => {
      try {
        const authToken = await getToken();
        setToken(authToken);
      } catch (error) {
        console.error("Failed to get auth token:", error);
      } finally {
        setIsLoadingToken(false);
      }
    };

    fetchToken();
  }, [getToken, isLoaded]);

  if (!isLoaded || isLoadingToken) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const connectionBuilder = DbConnection.builder()
    .withUri(env.VITE_SPACETIMEDB_HOST)
    .withModuleName(env.VITE_SPACETIMEDB_MODULE)
    .withToken(token ?? undefined)
    .onConnect(onConnect)
    .onDisconnect(onDisconnect)
    .onConnectError(onConnectError);

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-50 border-border border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container flex h-16 items-center justify-between px-4">
            <h1 className="font-semibold text-xl">CRM Chat</h1>
            <UserButton
              appearance={{
                elements: {
                  avatarBox: "h-9 w-9",
                },
              }}
            />
          </div>
        </header>
        <main className="container flex-1 px-4 py-8">
          <TelegramClientsManager />
        </main>
      </div>
    </SpacetimeDBProvider>
  );
}

export default App;
