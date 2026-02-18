/**
 * Result<T> — Rust-inspired discriminated union for mutation return types.
 *
 * Instead of throwing errors that produce opaque "Server Error" on the client,
 * mutations return `{ ok: true, value: T }` or `{ ok: false, error: string }`.
 *
 * Usage in a mutation:
 *   returns: result(v.null()),
 *   handler: async (ctx, args) => {
 *     if (!chat) return err("Chat not found");
 *     // ... do work
 *     return ok(null);
 *   }
 *
 * Usage for mutations that return data on success:
 *   returns: result(v.id("clients")),
 *   handler: async (ctx, args) => {
 *     const id = await ctx.db.insert(...);
 *     return ok(id);
 *   }
 */
import { type Validator, v } from "convex/values";

// todo create some smart hack and support it with convex typegen
// {Ok: O} | {Error: E}
/** Validator for Result<T>: v.union(ok branch, err branch). */
export function result<T extends Validator<any, "required", any>>(
  valueValidator: T,
): Validator<
  { ok: true; value: T["type"] } | { ok: false; error: string },
  "required",
  string
> {
  return v.union(
    v.object({ ok: v.literal(true), value: valueValidator }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ) as any;
}

/** Construct a success result. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true as const, value };
}

/** Construct an error result. */
export function err(error: string): { ok: false; error: string } {
  return { ok: false as const, error };
}
