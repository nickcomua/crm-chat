import { ConvexReactClient } from "convex/react";
import { anyApi } from "convex/server";
import { env } from "@/env";

/** Singleton Convex React client — created once at module load. */
export const convex = new ConvexReactClient(env.VITE_CONVEX_URL);

/**
 * Untyped API reference for Convex functions.
 *
 * Once `npx convex dev` is running against the backend, replace this with:
 *   import { api } from "../../convex/_generated/api";
 * for full type safety.
 */
export const api = anyApi;
