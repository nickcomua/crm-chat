import { ConvexReactClient } from "convex/react";
import { env } from "@/env";

/** Singleton Convex React client — created once at module load. */
export const convex = new ConvexReactClient(env.VITE_CONVEX_URL);

export { api } from "../../../convex-backend/convex/_generated/api";
export type {
  Doc,
  Id,
} from "../../../convex-backend/convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Result helpers — mirrors the Convex backend Result<T> pattern
// ---------------------------------------------------------------------------

/** Discriminated union returned by backend mutations. Matches serde's `Result<T, E>`. */
export type Result<T, E = string> = { Ok: T } | { Err: E };

/**
 * Chain onto a mutation call to log errors without changing call-site ergonomics.
 *
 * Usage: `mutation({ args }).then(onResultError)`
 */
export function onResultError(result: Result<unknown>): void {
  if ("Err" in result) {
    console.error("[mutation error]", result.Err);
  }
}
