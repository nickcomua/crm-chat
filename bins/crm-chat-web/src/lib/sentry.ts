import {
  browserTracingIntegration,
  init,
  replayIntegration,
  ErrorBoundary as SentryErrorBoundary,
} from "@sentry/react";
import { env } from "../env";

export function initSentry(): void {
  if (!env.VITE_SENTRY_DSN) {
    console.warn("Sentry DSN not configured, skipping initialization");
    return;
  }

  init({
    dsn: env.VITE_SENTRY_DSN,
    environment: env.VITE_SENTRY_ENVIRONMENT ?? "development",
    // Capture 100% of transactions for tracing
    tracesSampleRate: 1.0,
    // Session replay for debugging
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    // Integrate with React error boundaries
    integrations: [browserTracingIntegration(), replayIntegration()],
    // Debug mode for development
    debug: env.VITE_SENTRY_ENVIRONMENT !== "production",
  });

  console.log("Sentry initialized with DSN:", env.VITE_SENTRY_DSN);
}

// Re-export specific Sentry components for use elsewhere
export const ErrorBoundary = SentryErrorBoundary;
