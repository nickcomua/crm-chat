import { ClerkProvider } from "@clerk/clerk-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { env } from "@/env";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent(): React.ReactNode {
  return (
    <ThemeProvider>
      <ClerkProvider
        afterSignOutUrl="/"
        publishableKey={env.VITE_CLERK_PUBLISHABLE_KEY}
      >
        <QueryClientProvider client={queryClient}>
          <div className="min-h-screen bg-background">
            <Outlet />
          </div>
        </QueryClientProvider>
      </ClerkProvider>
    </ThemeProvider>
  );
}
