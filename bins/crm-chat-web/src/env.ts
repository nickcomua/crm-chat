import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Runtime environment variables injected by Docker container
// Falls back to import.meta.env for development
const getRuntimeEnv = () => {
  // @ts-expect-error - window.import is injected by env-config.js in production
  if (typeof window !== "undefined" && window.import?.meta?.env) {
    // @ts-expect-error - window.import is injected by env-config.js in production
    return window.import.meta.env;
  }
  return import.meta.env;
};

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_CLERK_PUBLISHABLE_KEY: z.string().optional(),
    VITE_CONVEX_URL: z.string().url(),
    VITE_ES_PROXY_URL: z.string().url().default("http://localhost:3001"),
    VITE_SENTRY_DSN: z.string().url().optional(),
    VITE_SENTRY_ENVIRONMENT: z.string().optional(),
  },
  runtimeEnv: getRuntimeEnv(),
  emptyStringAsUndefined: true,
});
