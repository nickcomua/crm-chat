import { useMutation, useQuery } from "convex/react";
import { api, type Doc, onResultError } from "@/lib/convex";



function isTerminalStep(step: Doc<'qrAuths'>['step']): boolean {
  return (
    step === "Authorized" ||
    step === "AlreadyAuthorized" ||
    step === "Failed" ||
    step === "Cancelled"
  );
}

interface UseQrAuthReturn {
  /** The current QR auth session (active or most recent terminal) */
  auth: Doc<'qrAuths'> | null;
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

  const authList = qrAuths ?? [];

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
    startQrAuthMutation({}).then(onResultError);
  };

  const cancelQrAuth = (): void => {
    if (auth && !isTerminalStep(auth.step)) {
      cancelQrAuthMutation({ authId: auth._id }).then(onResultError);
    }
  };

  return { auth, startQrAuth, cancelQrAuth };
}
