import { ConvexReactClient } from "convex/react";
import { env } from "@/env";

/** Singleton Convex React client — created once at module load. */
export const convex = new ConvexReactClient(env.VITE_CONVEX_URL);

export { api } from "../../../convex-backend/convex/_generated/api";
