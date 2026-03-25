import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Identity info extracted from ctx.auth */
export interface CallerIdentity {
  email?: string;
  /** Unique identifier (tokenIdentifier for Clerk, subject for worker JWT) */
  id: string;
  issuer: string;
  name?: string;
}

/** Extract and validate the caller's identity. Throws if not authenticated. */
// TODO make default mutation/query in functions.ts to have auth
export async function requireAuth(
  ctx: QueryCtx | MutationCtx
): Promise<CallerIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Authentication required");
  }
  return {
    id: identity.tokenIdentifier,
    issuer: identity.issuer,
    name: identity.name ?? undefined,
    email: identity.email ?? undefined,
  };
}

/** Check if a caller is a worker (Clerk M2M JWT with "mch_" subject prefix). */
export function isWorkerCaller(caller: CallerIdentity): boolean {
  // Convex tokenIdentifier = "{issuer}|{subject}"
  // Clerk M2M tokens have subject "mch_*", human tokens have "user_*"
  return caller.id.includes("|mch_");
}

/** Require the caller to be a human (Clerk-authenticated). */
// TODO create custom mutation/query in functions.ts
export async function requireHuman(
  ctx: QueryCtx | MutationCtx
): Promise<CallerIdentity> {
  const caller = await requireAuth(ctx);
  if (isWorkerCaller(caller)) {
    throw new Error("Unauthorized: this action is for human users only");
  }
  return caller;
}

/** Require the caller to be a worker (custom JWT). */
// TODO create custom mutation/query in functions.ts add query to eslint rule same as mutation
export async function requireWorker(
  ctx: QueryCtx | MutationCtx
): Promise<CallerIdentity> {
  const caller = await requireAuth(ctx);
  if (!isWorkerCaller(caller)) {
    throw new Error("Unauthorized: only workers can perform this action");
  }
  return caller;
}

/** Require the caller to own the resource (match userId). */
// TODO remove this we dont need 1 line helpers
export function requireOwner(callerId: string, resourceUserId: string): void {
  if (callerId !== resourceUserId) {
    throw new Error("Unauthorized: you do not own this resource");
  }
}

/** Check if a phone auth step is terminal. */
// TODO remove this bs
export function isPhoneAuthTerminal(step: string): boolean {
  return step === "Connected" || step === "Failed" || step === "Cancelled";
}

/** Check if a QR auth step is terminal. */
// TODO remove this bs
export function isQrAuthTerminal(step: string): boolean {
  return (
    step === "Authorized" ||
    step === "AlreadyAuthorized" ||
    step === "Failed" ||
    step === "Cancelled"
  );
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
