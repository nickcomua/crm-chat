import { RedirectToSignIn, UserButton, useAuth } from "@clerk/clerk-react";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { MessageSquare, Moon, Search, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { RightSidebar } from "@/components/right-sidebar";
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

function AuthLayout(): React.ReactNode {
  const { isLoaded, isSignedIn } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);

  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

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

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
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
    </ConvexProviderWithClerk>
  );
}
