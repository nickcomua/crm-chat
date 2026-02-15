import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { phoneAuthDoc, phoneAuthPublicDoc } from "./schema";
import {
  isPhoneAuthTerminal,
  requireAssignedWorker,
  requireHuman,
  requireOwner,
  requireWorker,
  sendError,
} from "./helpers/auth";
import { err, ok, result } from "./helpers/result";
import { enqueueClientStart, enqueueTask } from "./helpers/tasks";

// =============================================================================
// Validation — returns error string or null
// =============================================================================

function validatePhone(phone: string): string | null {
  if (!/^\+\d{7,15}$/.test(phone)) {
    return "Invalid phone number format. Use international format (e.g., +1234567890)";
  }
  return null;
}

function validateAuthCode(code: string): string | null {
  if (!/^\d{5}$/.test(code)) {
    return "Invalid code. Must be exactly 5 digits";
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (!password) {
    return "Password cannot be empty";
  }
  return null;
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
      .map(({ phoneCodeHash, loginCode, password, passwordToken, claimedByWorkerId, ...rest }) => rest);
  },
});

// =============================================================================
// Human Mutations
// =============================================================================

/** Start phone-based authentication. Creates a Client and PhoneAuth row. */
export const start = mutation({
  args: { phone: v.string() },
  returns: result(v.null()),
  handler: async (ctx, { phone }) => {
    const caller = await requireHuman(ctx);
    const phoneErr = validatePhone(phone);
    if (phoneErr) return err(phoneErr);
    const now = Date.now();

    // Check if client already exists for this user+phone
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_userId_telegramId", (q) =>
        q.eq("userId", caller.id).eq("telegramId", phone),
      )
      .unique();

    if (existing) {
      return err("Client already exists for this phone number");
    }

    // Create the client
    const clientId = await ctx.db.insert("clients", {
      userId: caller.id,
      kind: "Telegram",
      telegramId: phone,
      scanningChatIds: [],
      status: { type: "Authenticating" },
    });

    // Create the PhoneAuth row
    const authId = await ctx.db.insert("phoneAuths", {
      userId: caller.id,
      clientId,
      phone,
      step: "SendingCode",
      updatedAt: now,
    });

    // Enqueue worker task
    const auth = await ctx.db.get(authId);
    if (auth) {
      await enqueueTask(ctx, { type: "PhoneAuth:run", authId, doc: JSON.stringify(auth) });
    }

    return ok(null);
  },
});

/** User submits the SMS code. */
export const submitCode = mutation({
  args: { authId: v.id("phoneAuths"), code: v.string() },
  returns: result(v.null()),
  handler: async (ctx, { authId, code }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("PhoneAuth not found");
    requireOwner(caller.id, auth.userId);

    if (auth.step !== "WaitingCode") {
      return err(`Invalid step: expected WaitingCode, got ${auth.step}`);
    }
    const codeErr = validateAuthCode(code);
    if (codeErr) return err(codeErr);

    await ctx.db.patch(authId, {
      loginCode: code,
      step: "VerifyingCode",
      updatedAt: Date.now(),
    });

    // Enqueue worker task
    await enqueueTask(ctx, { type: "PhoneAuth:submitCode", authId });

    return ok(null);
  },
});

/** User submits 2FA password. */
export const submitPassword = mutation({
  args: { authId: v.id("phoneAuths"), password: v.string() },
  returns: result(v.null()),
  handler: async (ctx, { authId, password }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("PhoneAuth not found");
    requireOwner(caller.id, auth.userId);

    if (auth.step !== "WaitingPassword") {
      return err(`Invalid step: expected WaitingPassword, got ${auth.step}`);
    }
    const pwErr = validatePassword(password);
    if (pwErr) return err(pwErr);

    await ctx.db.patch(authId, {
      password,
      step: "VerifyingPassword",
      updatedAt: Date.now(),
    });

    // Enqueue worker task
    await enqueueTask(ctx, { type: "PhoneAuth:submitPassword", authId });

    return ok(null);
  },
});

/** User cancels the phone auth flow. */
export const cancel = mutation({
  args: { authId: v.id("phoneAuths") },
  returns: result(v.null()),
  handler: async (ctx, { authId }) => {
    const caller = await requireHuman(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("PhoneAuth not found");
    requireOwner(caller.id, auth.userId);

    if (isPhoneAuthTerminal(auth.step)) {
      return err("Cannot cancel: auth is already in a terminal state");
    }

    // Delete the associated client
    await ctx.db.delete(auth.clientId);

    await ctx.db.patch(authId, {
      step: "Cancelled",
      updatedAt: Date.now(),
    });

    // Enqueue worker task
    await enqueueTask(ctx, { type: "PhoneAuth:cancel", authId });

    return ok(null);
  },
});

// =============================================================================
// Worker Mutations
// =============================================================================

/** Worker claims a phone auth session. */
export const workerClaim = mutation({
  args: { authId: v.id("phoneAuths") },
  returns: result(v.null()),
  handler: async (ctx, { authId }) => {
    const caller = await requireWorker(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("PhoneAuth not found");

    if (auth.step !== "SendingCode") {
      return err(`Invalid step: expected SendingCode, got ${auth.step}`);
    }
    if (auth.claimedByWorkerId) {
      return err("PhoneAuth is already claimed by a worker");
    }

    await ctx.db.patch(authId, {
      claimedByWorkerId: caller.id,
      updatedAt: Date.now(),
    });
    return ok(null);
  },
});

/** Worker reports the result of sending the SMS code. */
export const workerCompleteSendCode = mutation({
  args: {
    authId: v.id("phoneAuths"),
    result: v.union(
      v.object({ type: v.literal("Success"), phoneCodeHash: v.string() }),
      v.object({ type: v.literal("AlreadyAuthorized") }),
      v.object({ type: v.literal("Failed"), error: v.string() }),
    ),
  },
  returns: result(v.null()),
  handler: async (ctx, { authId, result: sendCodeResult }) => {
    const caller = await requireWorker(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("PhoneAuth not found");
    requireAssignedWorker(caller.id, auth.claimedByWorkerId);

    if (auth.step !== "SendingCode") {
      return err(`Invalid step: expected SendingCode, got ${auth.step}`);
    }

    const now = Date.now();

    if (sendCodeResult.type === "Success") {
      await ctx.db.patch(authId, {
        phoneCodeHash: sendCodeResult.phoneCodeHash,
        step: "WaitingCode",
        updatedAt: now,
      });
    } else if (sendCodeResult.type === "AlreadyAuthorized") {
      // Update client to Connected
      await ctx.db.patch(auth.clientId, {
        status: { type: "Connected" },
      });
      await ctx.db.patch(authId, {
        step: "Connected",
        updatedAt: now,
      });
      // Enqueue client services
      const client = await ctx.db.get(auth.clientId);
      if (client) await enqueueClientStart(ctx, client);
    } else {
      // Failed
      await ctx.db.delete(auth.clientId);
      await sendError(ctx, auth.userId, `Failed to send login code: ${sendCodeResult.error}`);
      await ctx.db.patch(authId, {
        step: "Failed",
        error: sendCodeResult.error,
        updatedAt: now,
      });
    }
    return ok(null);
  },
});

/** Worker reports the result of verifying the login code. */
export const workerCompleteVerifyCode = mutation({
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
  returns: result(v.null()),
  handler: async (ctx, { authId, result: verifyResult }) => {
    const caller = await requireWorker(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("PhoneAuth not found");
    requireAssignedWorker(caller.id, auth.claimedByWorkerId);

    if (auth.step !== "VerifyingCode") {
      return err(`Invalid step: expected VerifyingCode, got ${auth.step}`);
    }

    const now = Date.now();

    switch (verifyResult.type) {
      case "Success": {
        await ctx.db.patch(auth.clientId, { status: { type: "Connected" } });
        await ctx.db.patch(authId, { step: "Connected", updatedAt: now });
        // Enqueue client services
        const client = await ctx.db.get(auth.clientId);
        if (client) await enqueueClientStart(ctx, client);
        break;
      }

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
          passwordHint: verifyResult.hint,
          passwordToken: verifyResult.passwordToken,
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
        await sendError(ctx, auth.userId, `Failed to verify login code: ${verifyResult.error}`);
        await ctx.db.patch(authId, {
          step: "Failed",
          error: verifyResult.error,
          updatedAt: now,
        });
        break;
    }
    return ok(null);
  },
});

/** Worker reports the result of verifying the 2FA password. */
export const workerCompleteVerifyPassword = mutation({
  args: {
    authId: v.id("phoneAuths"),
    result: v.union(
      v.object({ type: v.literal("Success"), userId: v.int64() }),
      v.object({ type: v.literal("InvalidPassword") }),
      v.object({ type: v.literal("Failed"), error: v.string() }),
    ),
  },
  returns: result(v.null()),
  handler: async (ctx, { authId, result: pwResult }) => {
    const caller = await requireWorker(ctx);
    const auth = await ctx.db.get(authId);
    if (!auth) return err("PhoneAuth not found");
    requireAssignedWorker(caller.id, auth.claimedByWorkerId);

    if (auth.step !== "VerifyingPassword") {
      return err(`Invalid step: expected VerifyingPassword, got ${auth.step}`);
    }

    const now = Date.now();

    switch (pwResult.type) {
      case "Success": {
        await ctx.db.patch(auth.clientId, { status: { type: "Connected" } });
        await ctx.db.patch(authId, { step: "Connected", updatedAt: now });
        // Enqueue client services
        const client = await ctx.db.get(auth.clientId);
        if (client) await enqueueClientStart(ctx, client);
        break;
      }

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
        await sendError(ctx, auth.userId, `Failed to verify password: ${pwResult.error}`);
        await ctx.db.patch(authId, {
          step: "Failed",
          error: pwResult.error,
          updatedAt: now,
        });
        break;
    }
    return ok(null);
  },
});
