/**
 * Custom function builders with auth wrappers.
 *
 * Exports:
 *
 * | Builder            | Auth      | `ctx.caller` |
 * |--------------------|-----------|--------------|
 * | `mutation`         | none      | —            |
 * | `internalMutation` | none      | —            |
 * | `humanMutation`    | human     | ✓            |
 * | `workerMutation`   | worker    | ✓            |
 * | `humanQuery`       | human     | ✓            |
 * | `workerQuery`      | worker    | ✓            |
 *
 * Use the bare `mutation`/`internalMutation` only for unauthenticated or
 * internal endpoints (e.g. `presence.disconnect`, scheduled mutations).
 * For everything else, prefer the typed auth builders — they validate the
 * caller and inject `ctx.caller: UserIdentity` automatically.
 */

import type { UserIdentity } from "convex/server";
import {
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  internalMutation as rawInternalMutation,
  mutation as rawMutation,
  query as rawQuery,
} from "./_generated/server";

// =============================================================================
// Auth helpers
// =============================================================================

/** Extract and validate the caller's identity. Throws if not authenticated. */
async function requireAuth(ctx: QueryCtx | MutationCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Authentication required");
  }
  return identity;
}

/** Check if a caller is a worker (Clerk M2M JWT with "mch_" subject prefix). */
function isWorkerCaller(caller: UserIdentity): boolean {
  // Convex tokenIdentifier = "{issuer}|{subject}"
  // Clerk M2M tokens have subject "mch_*", human tokens have "user_*"
  return caller.tokenIdentifier.includes("|mch_");
}

/** Require the caller to be a human (Clerk-authenticated). */
async function requireHuman(
  ctx: QueryCtx | MutationCtx
): Promise<UserIdentity> {
  const caller = await requireAuth(ctx);
  if (isWorkerCaller(caller)) {
    throw new Error("Unauthorized: this action is for human users only");
  }
  return caller;
}

/** Require the caller to be a worker (custom JWT). */
async function requireWorker(
  ctx: QueryCtx | MutationCtx
): Promise<UserIdentity> {
  const caller = await requireAuth(ctx);
  if (!isWorkerCaller(caller)) {
    throw new Error("Unauthorized: only workers can perform this action");
  }
  return caller;
}

/** Insert an error notification for a user. */
export async function sendError(
  ctx: MutationCtx,
  userId: string,
  message: string
): Promise<void> {
  await ctx.db.insert("notifications", {
    userId,
    severity: "Error" as const,
    message,
    dismissed: false,
  });
}

// =============================================================================
// Base builders (no auth)
// =============================================================================

/** Mutation. Use for unauthenticated endpoints (e.g. presence.disconnect). */
export const mutation = rawMutation;

/** Internal mutation. Use for scheduled/internal functions. */
export const internalMutation = rawInternalMutation;

// =============================================================================
// Auth-layered mutation builders (auth + ctx.caller)
// =============================================================================

/** Mutation requiring a human caller. Injects `ctx.caller`. */
export const humanMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const caller = await requireHuman(ctx);
    return { ctx: { caller }, args: {} };
  },
});

/** Mutation requiring a worker caller. Injects `ctx.caller`. */
export const workerMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const caller = await requireWorker(ctx);
    return { ctx: { caller }, args: {} };
  },
});

// =============================================================================
// Auth-layered query builders (auth + ctx.caller)
// =============================================================================

/** Query requiring a human caller. Injects `ctx.caller`. */
export const humanQuery = customQuery(rawQuery, {
  args: {},
  input: async (ctx) => {
    const caller = await requireHuman(ctx);
    return { ctx: { caller }, args: {} };
  },
});

/** Query requiring a worker caller. Injects `ctx.caller`. */
export const workerQuery = customQuery(rawQuery, {
  args: {},
  input: async (ctx) => {
    const caller = await requireWorker(ctx);
    return { ctx: { caller }, args: {} };
  },
});
