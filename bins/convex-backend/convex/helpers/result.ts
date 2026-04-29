/**
 * Result<T, E> — Rust-compatible discriminated union for mutation return types.
 *
 * Wire format: `{ Ok: T }` or `{ Err: E }` — matches serde's native
 * `Result<T, E>` externally-tagged enum serialization, so convex-typegen
 * can emit `Result<T, E>` directly in Rust with zero boilerplate.
 *
 * Usage in a mutation (typed error):
 *   returns: result(v.null(), v.literal("Chat not found")),
 *   handler: async (ctx, args) => {
 *     if (!chat) return err("Chat not found");
 *     return ok(null);
 *   }
 *
 * Usage with multiple error literals:
 *   returns: result(v.null(), v.union(v.literal("Not found"), v.literal("Unauthorized"))),
 *
 * Usage with dynamic errors:
 *   returns: result(v.null(), v.string()),
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/** biome-ignore-all lint/suspicious/noExplicitAny: safe generics */
import { type Validator, v } from "convex/values";

/** Validator for Result<T, E>: v.union(ok branch, err branch). */
export function result<
	T extends Validator<any, "required", any>,
	E extends Validator<any, "required", any>,
>(
	okValidator: T,
	errValidator: E,
): Validator<{ Ok: T["type"] } | { Err: E["type"] }, "required", string> {
	return v.union(
		v.object({ Ok: okValidator }),
		v.object({ Err: errValidator }),
	) as any;
}

/** Construct a success result. */
export function ok<const T>(value: T): { Ok: T } {
	return { Ok: value };
}

/** Construct an error result. */
export function err<const E>(error: E): { Err: E } {
	return { Err: error };
}
