import { useAuth } from "@clerk/clerk-react";
import usePresence from "@convex-dev/presence/react";
import { api } from "@/lib/convex";

const ROOM = "global";

/**
 * Presence wrapper — uses the library hook from `@convex-dev/presence/react`.
 *
 * Handles heartbeats, sendBeacon disconnect on beforeunload, and visibility-
 * change pause/resume automatically.
 *
 * The server-side `heartbeat` mutation ignores the client-sent userId and uses
 * `ctx.caller.tokenIdentifier` instead, so the exact value here doesn't matter
 * for security — it's only used by the library hook as a local identifier.
 *
 * Mount this once inside the authenticated Convex provider tree.
 */
export function useAppPresence(): void {
  const { userId } = useAuth();

  // The library hook handles everything: heartbeat, beforeunload, visibility.
  // We pass api.model.presence which exposes heartbeat/disconnect/list wrappers
  // matching the PresenceAPI shape the hook expects.
  usePresence(api.model.presence, ROOM, userId ?? "");
}
