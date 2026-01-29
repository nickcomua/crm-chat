import * as Sentry from "@sentry/react";
import { env } from "../env";

export function initSentry() {
  if (!env.VITE_SENTRY_DSN) {
    console.warn("Sentry DSN not configured, skipping initialization");
    return;
  }

  Sentry.init({
    dsn: env.VITE_SENTRY_DSN,
    environment: env.VITE_SENTRY_ENVIRONMENT ?? "development",
    
    // Capture 100% of transactions for tracing
    tracesSampleRate: 1.0,
    
    // Session replay for debugging
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    // Integrate with React error boundaries
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    
    // Debug mode for development
    debug: env.VITE_SENTRY_ENVIRONMENT !== "production",
  });

  // Expose Sentry on window for debugging
  if (typeof window !== "undefined") {
    (window as unknown as { Sentry: typeof Sentry }).Sentry = Sentry;
  }
  
  console.log("Sentry initialized with DSN:", env.VITE_SENTRY_DSN);
}

// Re-export Sentry for use elsewhere
export { Sentry };
