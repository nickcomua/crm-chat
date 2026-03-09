import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Test environment variables — loaded from .env via direnv or shell environment.
 *
 * Required vars must be present before tests start.
 * Optional vars (TG_SESSION_FILE_1, TG_USER_ID_1) gate real-Telegram tests.
 */
export const env = createEnv({
  server: {
    TEST_CLERK_USERNAME: z.string().min(1),
    TEST_CLERK_PASSWORD: z.string().min(1),
    VITE_CLERK_PUBLISHABLE_KEY: z.string().min(1),
    TG_ID: z.string().min(1),
    TG_HASH: z.string().min(1),
    TG_SESSION_FILE_1: z.string().min(1).optional(),
    TG_USER_ID_1: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
});
