import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { phoneAuthDoc, phoneAuthPublicDoc } from "./schema";
import {
  isPhoneAuthTerminal,
  requireAssignedRobot,
  requireHuman,
  requireOwner,
  requireRobot,
  sendError,
} from "./helpers/auth";

// =============================================================================
// Validation
// =============================================================================

function validatePhone(phone: string): void {
  if (!/^\+\d{7,15}$/.test(phone)) {
    throw new Error("Invalid phone number format. Use international format (e.g., +1234567890)");
  }
}

function validateAuthCode(code: string): void {
  if (!/^\d{5}$/.test(code)) {
    throw new Error("Invalid code. Must be exactly 5 digits");
  }
}

function validatePassword(password: string): void {
  if (!password) {
    throw new Error("Password cannot be empty");
  }
}

// =============================================================================
// Queries
// =============================================================================

/** Active (non-terminal) phone auths for the current human user. Secrets are stripped. */
export const active = query({
  args: {},
  returns: v.array(phoneAuthPublicDoc),
  handler: async (ctx) => {
    const caller = await requireHuman(ctx);
    const all = await ctx.db
      .query("phoneAuths")
      .withIndex("by_userId", (q) => q.eq("userId", caller.id))
      .collect();
    return all
      .filter((a) => !isPhoneAuthTerminal(a.step))
      .map(({ phoneCodeHash, loginCode, password, passwordToken, assignedRobot, ...rest }) => rest);
  },
});

/** Unclaimed phone auths (step=SendingCode, no assigned robot). For robot polling. */
export const pendingForRobot = query({
  args: {},
  returns: v.array(phoneAuthDoc),
  handler: async (ctx) => {
    await requireRobot(ctx);
    const pending = await ctx.db
      .query("phoneAuths")
      .withIndex("by_step", (q) => q.eq("step", "SendingCode"))
      .collect();
    return pending.filter((a) => !a.assignedRobot);
  },
});

/** Phone auths assigned to the calling robot. */
export const assignedToRobot = query({
  args: {},
  returns: v.array(phoneAuthDoc),
  handler: async (ctx) => {
    const caller = await requireRobot(ctx);
    const assigned = await ctx.db
      .query("phoneAuths")
      .withIndex("by_assignedRobot", (q) => q.eq("assignedRobot", caller.id))
      .collect();
    return assigned.filter((a) => !isPhoneAuthTerminal(a.step));
  },
});

// =============================================================================
// Human Mutations
// =============================================================================

/** Start phone-based authentication. Creates a Client and PhoneAuth row. */
export const start = mutation({
  args: { phone: v.string() },
  returns: v.null(),
  handler: async (ctx, { phone }) => {
    const caller = await requireHuman(ctx);
    validatePhone(phone);
    const now = Date.now();

    // Check if client already exists for this user+phone
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_userId_externalId", (q) =>
        q.eq("userId", caller.id).eq("externalId", phone),
      )
      .unique();

    if (existing) {
      throw new Error("Client already exists for this phone number");
    }

    // Create the client
    const clientId = await ctx.db.insert("clients", {
      userId: caller.id,
      kind: "Telegram",
      externalId: phone,
      activeChats: [],
      status: { type: "Authenticating" },
    });

    // Create the PhoneAuth row
    await ctx.db.insert("phoneAuths", {
      userId: caller.id,
      clientId,
      phone,
      step: "SendingCode",
      updatedAt: now,
    });
  },
});

/** User submits the SMS code. */
export const submitCode = mutation({
  args: { authId: v.id("phoneAuths"), code: v.string() },
  returns: v.null(),
  handler: async (ctx, { authId, code }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("PhoneAuth not found");
    requireOwner(caller.id, auth.userId);

    if (auth.step !== "WaitingCode") {
      throw new Error(`Invalid step: expected WaitingCode, got ${auth.step}`);
    }
    validateAuthCode(code);

    await ctx.db.patch(authId, {
      loginCode: code,
      step: "VerifyingCode",
      updatedAt: Date.now(),
    });
  },
});

/** User submits 2FA password. */
export const submitPassword = mutation({
  args: { authId: v.id("phoneAuths"), password: v.string() },
  returns: v.null(),
  handler: async (ctx, { authId, password }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("PhoneAuth not found");
    requireOwner(caller.id, auth.userId);

    if (auth.step !== "WaitingPassword") {
      throw new Error(`Invalid step: expected WaitingPassword, got ${auth.step}`);
    }
    validatePassword(password);

    await ctx.db.patch(authId, {
      password,
      step: "VerifyingPassword",
      updatedAt: Date.now(),
    });
  },
});

/** User cancels the phone auth flow. */
export const cancel = mutation({
  args: { authId: v.id("phoneAuths") },
  returns: v.null(),
  handler: async (ctx, { authId }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("PhoneAuth not found");
    requireOwner(caller.id, auth.userId);

    if (isPhoneAuthTerminal(auth.step)) {
      throw new Error("Cannot cancel: auth is already in a terminal state");
    }

    // Delete the associated client
    await ctx.db.delete(auth.clientId);

    await ctx.db.patch(authId, {
      step: "Cancelled",
      updatedAt: Date.now(),
    });
  },
});

// =============================================================================
// Robot Mutations
// =============================================================================

/** Robot claims a phone auth session. */
export const robotClaim = mutation({
  args: { authId: v.id("phoneAuths") },
  returns: v.null(),
  handler: async (ctx, { authId }) => {
    const caller = await requireRobot(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("PhoneAuth not found");

    if (auth.step !== "SendingCode") {
      throw new Error(`Invalid step: expected SendingCode, got ${auth.step}`);
    }
    if (auth.assignedRobot) {
      throw new Error("PhoneAuth is already claimed by a robot");
    }

    await ctx.db.patch(authId, {
      assignedRobot: caller.id,
      updatedAt: Date.now(),
    });
  },
});

/** Robot reports the result of sending the SMS code. */
export const robotCompleteSendCode = mutation({
  args: {
    authId: v.id("phoneAuths"),
    result: v.union(
      v.object({ type: v.literal("Success"), phoneCodeHash: v.string() }),
      v.object({ type: v.literal("AlreadyAuthorized") }),
      v.object({ type: v.literal("Failed"), error: v.string() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { authId, result }) => {
    const caller = await requireRobot(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("PhoneAuth not found");
    requireAssignedRobot(caller.id, auth.assignedRobot);

    if (auth.step !== "SendingCode") {
      throw new Error(`Invalid step: expected SendingCode, got ${auth.step}`);
    }

    const now = Date.now();

    if (result.type === "Success") {
      await ctx.db.patch(authId, {
        phoneCodeHash: result.phoneCodeHash,
        step: "WaitingCode",
        updatedAt: now,
      });
    } else if (result.type === "AlreadyAuthorized") {
      // Update client to Connected
      await ctx.db.patch(auth.clientId, {
        status: { type: "Connected" },
      });
      await ctx.db.patch(authId, {
        step: "Connected",
        updatedAt: now,
      });
    } else {
      // Failed
      await ctx.db.delete(auth.clientId);
      await sendError(ctx, auth.userId, `Failed to send login code: ${result.error}`);
      await ctx.db.patch(authId, {
        step: "Failed",
        error: result.error,
        updatedAt: now,
      });
    }
  },
});

/** Robot reports the result of verifying the login code. */
export const robotCompleteVerifyCode = mutation({
  args: {
    authId: v.id("phoneAuths"),
    result: v.union(
      v.object({ type: v.literal("Success"), userId: v.int64() }),
      v.object({ type: v.literal("InvalidCode") }),
      v.object({
        type: v.literal("PasswordRequired"),
        hint: v.optional(v.string()),
        passwordToken: v.string(),
      }),
      v.object({ type: v.literal("SignUpRequired") }),
      v.object({ type: v.literal("Failed"), error: v.string() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { authId, result }) => {
    const caller = await requireRobot(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("PhoneAuth not found");
    requireAssignedRobot(caller.id, auth.assignedRobot);

    if (auth.step !== "VerifyingCode") {
      throw new Error(`Invalid step: expected VerifyingCode, got ${auth.step}`);
    }

    const now = Date.now();

    switch (result.type) {
      case "Success":
        await ctx.db.patch(auth.clientId, { status: { type: "Connected" } });
        await ctx.db.patch(authId, { step: "Connected", updatedAt: now });
        break;

      case "InvalidCode":
        await sendError(ctx, auth.userId, "Invalid code. Please try again.");
        await ctx.db.patch(authId, {
          loginCode: undefined,
          step: "WaitingCode",
          updatedAt: now,
        });
        break;

      case "PasswordRequired":
        await ctx.db.patch(authId, {
          passwordHint: result.hint,
          passwordToken: result.passwordToken,
          step: "WaitingPassword",
          updatedAt: now,
        });
        break;

      case "SignUpRequired":
        await ctx.db.delete(auth.clientId);
        await sendError(
          ctx,
          auth.userId,
          "Sign up required. This phone number is not registered with Telegram.",
        );
        await ctx.db.patch(authId, {
          step: "Failed",
          error: "Sign up required",
          updatedAt: now,
        });
        break;

      case "Failed":
        await ctx.db.delete(auth.clientId);
        await sendError(ctx, auth.userId, `Failed to verify login code: ${result.error}`);
        await ctx.db.patch(authId, {
          step: "Failed",
          error: result.error,
          updatedAt: now,
        });
        break;
    }
  },
});

/** Robot reports the result of verifying the 2FA password. */
export const robotCompleteVerifyPassword = mutation({
  args: {
    authId: v.id("phoneAuths"),
    result: v.union(
      v.object({ type: v.literal("Success"), userId: v.int64() }),
      v.object({ type: v.literal("InvalidPassword") }),
      v.object({ type: v.literal("Failed"), error: v.string() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { authId, result }) => {
    const caller = await requireRobot(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) throw new Error("PhoneAuth not found");
    requireAssignedRobot(caller.id, auth.assignedRobot);

    if (auth.step !== "VerifyingPassword") {
      throw new Error(`Invalid step: expected VerifyingPassword, got ${auth.step}`);
    }

    const now = Date.now();

    switch (result.type) {
      case "Success":
        await ctx.db.patch(auth.clientId, { status: { type: "Connected" } });
        await ctx.db.patch(authId, { step: "Connected", updatedAt: now });
        break;

      case "InvalidPassword":
        await sendError(ctx, auth.userId, "Invalid password. Please try again.");
        await ctx.db.patch(authId, {
          password: undefined,
          step: "WaitingPassword",
          updatedAt: now,
        });
        break;

      case "Failed":
        await ctx.db.delete(auth.clientId);
        await sendError(ctx, auth.userId, `Failed to verify password: ${result.error}`);
        await ctx.db.patch(authId, {
          step: "Failed",
          error: result.error,
          updatedAt: now,
        });
        break;
    }
  },
});
