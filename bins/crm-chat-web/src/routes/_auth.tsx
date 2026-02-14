import { RedirectToSignIn, UserButton, useAuth } from "@clerk/clerk-react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache";
import {
  Download,
  MessageSquare,
  Moon,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { NotificationsBellPanel } from "@/components/right-sidebar";
import { SearchDialog } from "@/components/search-dialog";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import { convex } from "@/lib/convex";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
});

function ThemeToggle(): React.ReactNode {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      className="h-8 w-8"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      size="icon"
      variant="ghost"
    >
      {resolvedTheme === "dark" ? (
        <Sun className="h-3.5 w-3.5" />
      ) : (
        <Moon className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}

function AuthLayout(): React.ReactNode {
  const { isLoaded, isSignedIn } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

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

  if (!isSignedIn) {
    return <RedirectToSignIn />;
  }

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      <ConvexQueryCacheProvider>
        <div className="flex h-screen flex-col">
          <header className="sticky top-0 z-50 border-border/40 border-b bg-background/90 backdrop-blur-xl">
            <div className="flex h-12 items-center justify-between px-4">
              <div className="flex items-center gap-4">
                <h1 className="font-display font-semibold text-base tracking-tight">
                  CRM Chat
                </h1>
                <div className="hidden h-4 w-px bg-border sm:block" />
                <nav className="flex items-center gap-0.5">
                  <Link
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium text-[13px] transition-all",
                      currentPath.startsWith("/chats")
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    to="/chats"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Chats</span>
                  </Link>
                  <Link
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium text-[13px] transition-all",
                      currentPath === "/downloads"
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    to="/downloads"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Downloads</span>
                  </Link>
                  <Link
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium text-[13px] transition-all",
                      currentPath === "/settings"
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    to="/settings"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Settings</span>
                  </Link>
                </nav>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  className="h-8 w-8"
                  onClick={() => setSearchOpen(true)}
                  size="icon"
                  variant="ghost"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span className="sr-only">Search messages</span>
                </Button>
                <NotificationsBellPanel
                  onOpenChange={setNotificationsOpen}
                  open={notificationsOpen}
                />
                <ThemeToggle />
                <div className="ml-1.5 h-4 w-px bg-border" />
                <div className="ml-1.5">
                  <UserButton
                    appearance={{
                      elements: {
                        avatarBox: "h-6 w-6",
                      },
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
          </header>
          <div className="flex flex-1 overflow-hidden">
            <main className="flex-1 overflow-hidden">
              <Outlet />
            </main>
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
      </ConvexQueryCacheProvider>
    </ConvexProviderWithClerk>
  );
}
