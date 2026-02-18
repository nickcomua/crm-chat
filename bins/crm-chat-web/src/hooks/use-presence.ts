import usePresence from "@convex-dev/presence/react";
import { useQuery } from "convex/react";
import { api } from "@/lib/convex";

const ROOM = "global";

/**
 * Presence wrapper — uses the library hook from `@convex-dev/presence/react`.
 *
 * Handles heartbeats, sendBeacon disconnect on beforeunload, and visibility-
 * change pause/resume automatically.
 *
 * Mount this once inside the authenticated Convex provider tree.
 */
export function useAppPresence(): void {
  const userId = useQuery(api.presence.getUserId);

  // The library hook handles everything: heartbeat, beforeunload, visibility.
  // We pass api.presence which exposes heartbeat/disconnect/list wrappers
  // matching the PresenceAPI shape the hook expects.
  usePresence(api.presence, ROOM, userId ?? "");
}
