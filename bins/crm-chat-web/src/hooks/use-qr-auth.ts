import { useMutation, useQuery } from "convex/react";
import { api } from "@/lib/convex";

type QrAuthStep =
  | "Pending"
  | "Generating"
  | "Token"
  | "Authorized"
  | "AlreadyAuthorized"
  | "Failed"
  | "Cancelled";

interface QrAuthDoc {
  _id: string;
  _creationTime: number;
  step: QrAuthStep;
  qrUrl?: string;
  qrExpires?: number;
  error?: string;
}

function isTerminalStep(step: QrAuthStep): boolean {
  return (
    step === "Authorized" ||
    step === "AlreadyAuthorized" ||
    step === "Failed" ||
    step === "Cancelled"
  );
}

interface UseQrAuthReturn {
  /** The current QR auth session (active or most recent terminal) */
  auth: QrAuthDoc | null;
  /** Start a new QR auth session */
  startQrAuth: () => void;
  /** Cancel the active QR auth session */
  cancelQrAuth: () => void;
}

/**
 * Hook for managing QR auth sessions via the qrAuths table.
 */
export function useQrAuth(): UseQrAuthReturn {
  const qrAuths = useQuery(api.qrAuth.listForUser);
  const startQrAuthMutation = useMutation(api.qrAuth.start);
  const cancelQrAuthMutation = useMutation(api.qrAuth.cancel);

  const authList: QrAuthDoc[] = qrAuths ?? [];

  // Prefer an active (non-terminal) session; otherwise show the most recent
  const activeAuth = authList.find((a) => !isTerminalStep(a.step));
  const latestAuth =
    authList.length > 0
      ? authList.reduce((latest, curr) =>
          curr._creationTime > latest._creationTime ? curr : latest
        )
      : null;
  const auth = activeAuth ?? latestAuth ?? null;

  const startQrAuth = (): void => {
    startQrAuthMutation({});
  };

  const cancelQrAuth = (): void => {
    if (auth && !isTerminalStep(auth.step)) {
      cancelQrAuthMutation({ authId: auth._id });
    }
  };

  return { auth, startQrAuth, cancelQrAuth };
}
