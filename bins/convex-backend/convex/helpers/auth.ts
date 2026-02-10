import {
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

/** Identity info extracted from ctx.auth */
export type CallerIdentity = {
  /** Unique identifier (tokenIdentifier for Clerk, subject for robot JWT) */
  id: string;
  issuer: string;
  name?: string;
  email?: string;
};

/** Extract and validate the caller's identity. Throws if not authenticated. */
export async function requireAuth(ctx: QueryCtx | MutationCtx): Promise<CallerIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Authentication required");
  }
  return {
    id: identity.tokenIdentifier,
    issuer: identity.issuer ?? "",
    name: identity.name ?? undefined,
    email: identity.email ?? undefined,
  };
}

/** Require the caller to be a human (Clerk-authenticated). */
export async function requireHuman(ctx: QueryCtx | MutationCtx): Promise<CallerIdentity> {
  const caller = await requireAuth(ctx);
  if (caller.issuer === "https://crm-chat-robot.local") {
    throw new Error("Unauthorized: this action is for human users only");
  }
  return caller;
}

/** Require the caller to be a robot (custom JWT). */
export async function requireRobot(ctx: QueryCtx | MutationCtx): Promise<CallerIdentity> {
  const caller = await requireAuth(ctx);
  if (caller.issuer !== "https://crm-chat-robot.local") {
    throw new Error("Unauthorized: only robots can perform this action");
  }
  return caller;
}

/** Require the caller to own the resource (match userId). */
export function requireOwner(callerId: string, resourceUserId: string): void {
  if (callerId !== resourceUserId) {
    throw new Error("Unauthorized: you do not own this resource");
  }
}

/** Require the caller to be the assigned robot for an auth session. */
export function requireAssignedRobot(callerId: string, assignedRobot: string | undefined): void {
  if (!assignedRobot || assignedRobot !== callerId) {
    throw new Error("Unauthorized: not assigned to this robot");
  }
}

/** Check if a phone auth step is terminal. */
export function isPhoneAuthTerminal(step: string): boolean {
  return step === "Connected" || step === "Failed" || step === "Cancelled";
}

/** Check if a QR auth step is terminal. */
export function isQrAuthTerminal(step: string): boolean {
  return step === "Authorized" || step === "AlreadyAuthorized" || step === "Failed" || step === "Cancelled";
}
