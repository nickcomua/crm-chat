import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Pre-existing env vars — available before globalSetup runs.
 * Loaded from .env via direnv or shell environment.
 */
export const staticEnv = createEnv({
  server: {
    TEST_CLERK_USERNAME: z.string().min(1),
    TEST_CLERK_PASSWORD: z.string().min(1),
    VITE_CLERK_PUBLISHABLE_KEY: z.string().min(1),
    TG_ID: z.string().min(1),
    TG_HASH: z.string().min(1),
  },
  runtimeEnv: process.env,
});

/**
 * Dynamic env vars — set by the workerBackend fixture after container start.
 * Available in test code (helpers, specs) once the fixture has initialized.
 */
export function getDynamicEnv(): {
  E2E_CONVEX_URL: string;
  E2E_ROBOT_PRIVATE_KEY: string;
} {
  const url = process.env.E2E_CONVEX_URL;
  const key = process.env.E2E_ROBOT_PRIVATE_KEY;
  if (!(url && key)) {
    throw new Error(
      "E2E_CONVEX_URL / E2E_ROBOT_PRIVATE_KEY not set — has the workerBackend fixture initialized?"
    );
  }
  return { E2E_CONVEX_URL: url, E2E_ROBOT_PRIVATE_KEY: key };
}

/**
 * Optional Telegram session env vars for real-session E2E tests.
 * Returns null if not set — tests should skip when absent.
 *
 * TG_SESSION_FILE_1: path to a pre-authenticated .session file
 * TG_USER_ID_1: the Telegram user ID (numeric string)
 */
export function getSessionEnv(): {
  sessionFile: string;
  userId: string;
} | null {
  const sessionFile = process.env.TG_SESSION_FILE_1;
  const userId = process.env.TG_USER_ID_1;
  if (!(sessionFile && userId)) {
    return null;
  }
  return { sessionFile, userId };
}
