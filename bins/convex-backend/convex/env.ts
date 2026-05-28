/// <reference types="node" />
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    CLERK_JWT_ISSUER_DOMAIN: z
      .string()
      .url()
      .transform((s) => (s.endsWith("/") ? s.slice(0, -1) : s)),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
