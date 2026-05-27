import { ConvexReactClient } from "convex/react";
import { env } from "@/env";

/** Singleton Convex React client — created once at module load. */
export const convex = new ConvexReactClient(env.VITE_CONVEX_URL);

export { api } from "crm-chat-convex-backend/convex/_generated/api";
export type {
	Doc,
	Id,
} from "crm-chat-convex-backend/convex/_generated/dataModel";

/** Handle Result<T, E> errors from mutations. Usage: `myMutation(args).then(onResultError)` */
export function onResultError(result: unknown): void {
	if (result && typeof result === "object" && "Err" in result) {
		console.error("[mutation error]", (result as { Err: unknown }).Err);
	}
}
