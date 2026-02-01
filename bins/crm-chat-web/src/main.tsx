import { ClerkProvider } from "@clerk/clerk-react";
import {
  createHashHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { env } from "./env";
import { ErrorBoundary, initSentry } from "./lib/sentry";
import { routeTree } from "./routeTree.gen";
import "./index.css";

// Initialize Sentry as early as possible
initSentry();

// Create hash history for static hosting (no server-side routing needed)
const hashHistory = createHashHistory();

// Create the router instance
const router = createRouter({
  routeTree,
  history: hashHistory,
  defaultPreload: "intent",
});

// Register the router for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement && !rootElement.innerHTML) {
  const clerkPubKey = env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!clerkPubKey) {
    console.error("Missing VITE_CLERK_PUBLISHABLE_KEY");
  }
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={clerkPubKey ?? ""}>
        <ErrorBoundary fallback={<p>Something went wrong</p>}>
          <RouterProvider router={router} />
        </ErrorBoundary>
      </ClerkProvider>
    </StrictMode>
  );
}
