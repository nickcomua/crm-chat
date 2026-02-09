import type { Infer } from "spacetimedb";
import { useReducer, useTable } from "spacetimedb/react";
import {
  type QrAuth,
  type QrAuthStep,
  reducers,
  tables,
} from "@/lib/spacetime";

type QrAuthType = Infer<typeof QrAuth>;
type QrAuthStepType = Infer<typeof QrAuthStep>;

function isTerminalStep(step: QrAuthStepType): boolean {
  return (
    step.tag === "Authorized" ||
    step.tag === "AlreadyAuthorized" ||
    step.tag === "Failed" ||
    step.tag === "Cancelled"
  );
}

interface UseQrAuthReturn {
  /** The current QR auth session (active or most recent terminal) */
  auth: QrAuthType | null;
  /** Start a new QR auth session */
  startQrAuth: () => void;
  /** Cancel the active QR auth session */
  cancelQrAuth: () => void;
}

/**
 * Hook for managing QR auth sessions via the qr_auth table.
 */
export function useQrAuth(): UseQrAuthReturn {
  const [qrAuths] = useTable(tables.qrAuth);
  const startQrAuthReducer = useReducer(reducers.startQrAuth);
  const cancelQrAuthReducer = useReducer(reducers.cancelQrAuth);

  // Prefer an active (non-terminal) session; otherwise show the most recent
  const activeAuth = qrAuths.find((a) => !isTerminalStep(a.step));
  const latestAuth =
    qrAuths.length > 0
      ? qrAuths.reduce((latest, curr) => (curr.id > latest.id ? curr : latest))
      : null;
  const auth = activeAuth ?? latestAuth ?? null;

  const startQrAuth = (): void => {
    startQrAuthReducer({});
  };

  const cancelQrAuth = (): void => {
    if (auth && !isTerminalStep(auth.step)) {
      cancelQrAuthReducer({ authId: auth.id });
    }
  };

  return { auth, startQrAuth, cancelQrAuth };
}
