import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  humanMutation,
  humanQuery,
  sendError,
  workerMutation,
  workerQuery,
} from "../functions";
import { err, ok, result } from "../helpers/result";
import { workItem } from "../helpers/validators";

// =============================================================================
// Table-specific validators
// =============================================================================

export const phoneAuthStep = v.union(
  v.literal("SendingCode"),
  v.literal("WaitingCode"),
  v.literal("VerifyingCode"),
  v.literal("WaitingPassword"),
  v.literal("VerifyingPassword"),
  v.literal("Connected"),
  v.literal("Failed"),
  v.literal("Cancelled")
);

const phoneAuthFields = v.object({
  userId: v.string(),
  clientId: v.id("clients"),
  phone: v.string(),
  step: phoneAuthStep,
  phoneCodeHash: v.optional(v.string()),
  loginCode: v.optional(v.string()),
  passwordToken: v.optional(v.string()),
  password: v.optional(v.string()),
  passwordHint: v.optional(v.string()),
  error: v.optional(v.string()),
  claimedByWorkerId: v.optional(v.string()),
  updatedAt: v.number(),
});

export const phoneAuthDoc = phoneAuthFields.extend({
  _id: v.id("phoneAuths"),
  _creationTime: v.number(),
});

/** phoneAuthDoc without secrets -- safe for human-facing queries. */
export const phoneAuthPublicDoc = v.object({
  _id: v.id("phoneAuths"),
  _creationTime: v.number(),
  userId: v.string(),
  clientId: v.id("clients"),
  phone: v.string(),
  step: phoneAuthStep,
  passwordHint: v.optional(v.string()),
  error: v.optional(v.string()),
  updatedAt: v.number(),
});

export const phoneAuthsTable = defineTable(phoneAuthFields)
  .index("by_userId", ["userId"])
  .index("by_step", ["step"])
  .index("by_claimedByWorkerId", ["claimedByWorkerId"])
  .index("by_clientId", ["clientId"]);

const PHONE_AUTH_TERMINAL = new Set(["Connected", "Failed", "Cancelled"]);

// =============================================================================
// Validation — returns error string or null
// =============================================================================

const PHONE_RE = /^\+\d{7,15}$/;
const AUTH_CODE_RE = /^\d{5}$/;

function validatePhone(phone: string): string | null {
  if (!PHONE_RE.test(phone)) {
    return "Invalid phone number format. Use international format (e.g., +1234567890)";
  }
  return null;
}

function validateAuthCode(code: string): string | null {
  if (!AUTH_CODE_RE.test(code)) {
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
export const active = humanQuery({
  args: {},
  returns: v.array(phoneAuthPublicDoc),
  handler: async (ctx) => {
    const all = await ctx.db
      .query("phoneAuths")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.caller.tokenIdentifier))
      .collect();
    return all
      .filter((a) => !PHONE_AUTH_TERMINAL.has(a.step))
      .map(
        ({
          phoneCodeHash: _phoneCodeHash,
          loginCode: _loginCode,
          password: _password,
          passwordToken: _passwordToken,
          claimedByWorkerId: _claimedByWorkerId,
          ...rest
        }) => rest
      );
  },
});

/**
 * Get a phoneAuth row by ID. Worker-only.
 * The worker subscribes to this to detect step changes (e.g., WaitingCode → VerifyingCode).
 */
export const getForWorker = workerQuery({
  args: { authId: v.id("phoneAuths") },
  returns: v.union(phoneAuthDoc, v.null()),
  handler: async (ctx, { authId }) => {
    return await ctx.db.get(authId);
  },
});

/**
 * Lightweight step query for domain cancel-watcher.
 * Rust handler subscribes to this and cancels when step becomes terminal.
 */
export const getStep = workerQuery({
  args: { authId: v.id("phoneAuths") },
  returns: v.union(phoneAuthStep, v.null()),
  handler: async (ctx, { authId }) => {
    const auth = await ctx.db.get(authId);
    return auth?.step ?? null;
  },
});

// =============================================================================
// Human Mutations
// =============================================================================

/** Start phone-based authentication. Creates a Client and PhoneAuth row. */
export const start = humanMutation({
  args: { phone: v.string() },
  returns: result(v.null(), v.string()),
  handler: async (ctx, { phone }) => {
    const phoneErr = validatePhone(phone);
    if (phoneErr) {
      return err(phoneErr);
    }
    const now = Date.now();

    const telegramId = `telegram:${phone}`;

    // Check if client already exists for this user+phone
    const existing = await ctx.db
      .query("clients")
      .withIndex("by_userId_telegramId", (q) =>
        q.eq("userId", ctx.caller.tokenIdentifier).eq("telegramId", telegramId)
      )
      .unique();

    if (existing) {
      return err("Client already exists for this phone number");
    }

    // Create the client
    const clientId = await ctx.db.insert("clients", {
      userId: ctx.caller.tokenIdentifier,
      kind: "Telegram",
      telegramId,
      scanningChatIds: [],
      status: { type: "Authenticating" },
    });

    // Create the PhoneAuth row — phoneAuth.pendingWork discovers it via step
    await ctx.db.insert("phoneAuths", {
      userId: ctx.caller.tokenIdentifier,
      clientId,
      phone,
      step: "SendingCode",
      updatedAt: now,
    });

    // phoneAuth step "SendingCode" is picked up by phoneAuth.pendingWork
    return ok(null);
  },
});

/** User submits the SMS code. */
export const submitCode = humanMutation({
  args: { authId: v.id("phoneAuths"), code: v.string() },
  returns: result(v.null(), v.string()),
  handler: async (ctx, { authId, code }) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return err("PhoneAuth not found");
    }
    if (auth.userId !== ctx.caller.tokenIdentifier) {
      throw new Error("Unauthorized: you do not own this resource");
    }

    if (auth.step !== "WaitingCode") {
      return err(`Invalid step: expected WaitingCode, got ${auth.step}`);
    }
    const codeErr = validateAuthCode(code);
    if (codeErr) {
      return err(codeErr);
    }

    // Worker detects VerifyingCode step via subscription — no task enqueue needed
    await ctx.db.patch(authId, {
      loginCode: code,
      step: "VerifyingCode",
      updatedAt: Date.now(),
    });

    return ok(null);
  },
});

/** User submits 2FA password. */
export const submitPassword = humanMutation({
  args: { authId: v.id("phoneAuths"), password: v.string() },
  returns: result(v.null(), v.string()),
  handler: async (ctx, { authId, password }) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return err("PhoneAuth not found");
    }
    if (auth.userId !== ctx.caller.tokenIdentifier) {
      throw new Error("Unauthorized: you do not own this resource");
    }

    if (auth.step !== "WaitingPassword") {
      return err(`Invalid step: expected WaitingPassword, got ${auth.step}`);
    }
    const pwErr = validatePassword(password);
    if (pwErr) {
      return err(pwErr);
    }

    // Worker detects VerifyingPassword step via subscription — no task enqueue needed
    await ctx.db.patch(authId, {
      password,
      step: "VerifyingPassword",
      updatedAt: Date.now(),
    });

    return ok(null);
  },
});

/** User cancels the phone auth flow. Worker detects via task status + phoneAuth step. */
export const cancel = humanMutation({
  args: { authId: v.id("phoneAuths") },
  returns: result(
    v.null(),
    v.union(
      v.literal("PhoneAuth not found"),
      v.literal("Cannot cancel: auth is already in a terminal state")
    )
  ),
  handler: async (ctx, { authId }) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return err("PhoneAuth not found");
    }
    if (auth.userId !== ctx.caller.tokenIdentifier) {
      throw new Error("Unauthorized: you do not own this resource");
    }

    if (PHONE_AUTH_TERMINAL.has(auth.step)) {
      return err("Cannot cancel: auth is already in a terminal state");
    }

    // Set phase to Disconnected so domain cancel-watchers fire
    await ctx.db.patch(auth.clientId, { phase: "Disconnected" });
    await ctx.db.delete(auth.clientId);

    await ctx.db.patch(authId, {
      step: "Cancelled",
      updatedAt: Date.now(),
    });

    return ok(null);
  },
});

// =============================================================================
// Worker Mutations
// =============================================================================

/** Worker reports the result of sending the SMS code. */
export const workerCompleteSendCode = workerMutation({
  args: {
    authId: v.id("phoneAuths"),
    result: v.union(
      v.object({ type: v.literal("Success"), phoneCodeHash: v.string() }),
      v.object({ type: v.literal("AlreadyAuthorized") }),
      v.object({ type: v.literal("Failed"), error: v.string() })
    ),
  },
  returns: result(v.null(), v.string()),
  handler: async (ctx, { authId, result: sendCodeResult }) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return err("PhoneAuth not found");
    }

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
      // Update client to Connected + NeedsSync — reconciler dispatches DialogSync
      await ctx.db.patch(auth.clientId, {
        status: { type: "Connected" },
        phase: "NeedsSync" as const,
      });
      await ctx.db.patch(authId, {
        step: "Connected",
        updatedAt: now,
      });
    } else {
      // Failed
      await ctx.db.delete(auth.clientId);
      await sendError(
        ctx,
        auth.userId,
        `Failed to send login code: ${sendCodeResult.error}`
      );
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
export const workerCompleteVerifyCode = workerMutation({
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
      v.object({ type: v.literal("Failed"), error: v.string() })
    ),
  },
  returns: result(v.null(), v.string()),
  handler: async (ctx, { authId, result: verifyResult }) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return err("PhoneAuth not found");
    }

    if (auth.step !== "VerifyingCode") {
      return err(`Invalid step: expected VerifyingCode, got ${auth.step}`);
    }

    const now = Date.now();

    switch (verifyResult.type) {
      case "Success": {
        await ctx.db.patch(auth.clientId, {
          status: { type: "Connected" },
          phase: "NeedsSync" as const,
          externalId: verifyResult.userId.toString(),
        });
        await ctx.db.patch(authId, { step: "Connected", updatedAt: now });
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
          "Sign up required. This phone number is not registered with Telegram."
        );
        await ctx.db.patch(authId, {
          step: "Failed",
          error: "Sign up required",
          updatedAt: now,
        });
        break;

      case "Failed":
        await ctx.db.delete(auth.clientId);
        await sendError(
          ctx,
          auth.userId,
          `Failed to verify login code: ${verifyResult.error}`
        );
        await ctx.db.patch(authId, {
          step: "Failed",
          error: verifyResult.error,
          updatedAt: now,
        });
        break;

      default:
        throw new Error(
          `Unknown verify result type: ${(verifyResult as { type: string }).type}`
        );
    }
    return ok(null);
  },
});

/** Worker reports the result of verifying the 2FA password. */
export const workerCompleteVerifyPassword = workerMutation({
  args: {
    authId: v.id("phoneAuths"),
    result: v.union(
      v.object({ type: v.literal("Success"), userId: v.int64() }),
      v.object({ type: v.literal("InvalidPassword") }),
      v.object({ type: v.literal("Failed"), error: v.string() })
    ),
  },
  returns: result(v.null(), v.string()),
  handler: async (ctx, { authId, result: pwResult }) => {
    const auth = await ctx.db.get(authId);
    if (!auth) {
      return err("PhoneAuth not found");
    }

    if (auth.step !== "VerifyingPassword") {
      return err(`Invalid step: expected VerifyingPassword, got ${auth.step}`);
    }

    const now = Date.now();

    switch (pwResult.type) {
      case "Success": {
        await ctx.db.patch(auth.clientId, {
          status: { type: "Connected" },
          phase: "NeedsSync" as const,
          externalId: pwResult.userId.toString(),
        });
        await ctx.db.patch(authId, { step: "Connected", updatedAt: now });
        break;
      }

      case "InvalidPassword":
        await sendError(
          ctx,
          auth.userId,
          "Invalid password. Please try again."
        );
        await ctx.db.patch(authId, {
          password: undefined,
          step: "WaitingPassword",
          updatedAt: now,
        });
        break;

      case "Failed":
        await ctx.db.delete(auth.clientId);
        await sendError(
          ctx,
          auth.userId,
          `Failed to verify password: ${pwResult.error}`
        );
        await ctx.db.patch(authId, {
          step: "Failed",
          error: pwResult.error,
          updatedAt: now,
        });
        break;

      default:
        throw new Error(
          `Unknown password result type: ${(pwResult as { type: string }).type}`
        );
    }
    return ok(null);
  },
});

// =============================================================================
// Pending work (for reconciler dispatch)
// =============================================================================

/** Phone auth sessions that need a worker. */
export const pendingWork = workerQuery({
  args: {},
  returns: v.array(workItem),
  handler: async (ctx) => {
    const work: { service: string; key: string; handler: string }[] = [];
    for (const step of [
      "SendingCode",
      "VerifyingCode",
      "VerifyingPassword",
    ] as const) {
      const auths = await ctx.db
        .query("phoneAuths")
        .withIndex("by_step", (q) => q.eq("step", step))
        .collect();
      for (const a of auths) {
        work.push({
          service: "PhoneAuthWorkflow",
          key: a._id,
          handler: "run",
        });
      }
    }
    return work;
  },
});
