import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api, type Id } from "@/lib/convex";

type QrAuthStep =
  | "Pending"
  | "Generating"
  | "Token"
  | "Authorized"
  | "AlreadyAuthorized"
  | "Failed"
  | "Cancelled";

export interface QrAuthProgress {
  error: string | undefined;
  qrExpires: number | undefined;
  qrUrl: string | undefined;
  step: QrAuthStep;
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
  /** Cancel the active QR auth session */
  cancelQrAuth: () => void;
  /** True when the auth reached a successful terminal state */
  isDone: boolean;
  /** Current progress, or null if auth doesn't exist */
  progress: QrAuthProgress | null;
  /** Start a new QR auth session */
  startQrAuth: () => void;
}

/**
 * Hook for managing QR auth sessions via the qrAuths table.
 */
export function useQrAuth(): UseQrAuthReturn {
  const [authId, setAuthId] = useState<Id<"qrAuths"> | null>(null);
  const startMutation = useMutation(api.model.qrAuth.start);
  const cancelMutation = useMutation(api.model.qrAuth.cancel);

  // Subscribe to the qrAuth record
  const queryResult = useQuery(
    api.model.qrAuth.getForUser,
    authId ? { authId } : "skip"
  );

  let progress: QrAuthProgress | null = null;
  if (queryResult) {
    progress = {
      step: queryResult.step as QrAuthStep,
      qrUrl: queryResult.qrUrl,
      qrExpires: queryResult.qrExpires,
      error: queryResult.error,
    };
  }

  // isDone = auth reached a successful terminal state (Authorized/AlreadyAuthorized)
  const isDone =
    authId !== null &&
    queryResult !== undefined &&
    queryResult !== null &&
    (queryResult.step === "Authorized" ||
      queryResult.step === "AlreadyAuthorized");

  const startQrAuth = (): void => {
    setAuthId(null);
    startMutation({}).then(
      (id) => setAuthId(id),
      (error) => console.error("[qrAuth.start]", error)
    );
  };

  const cancelQrAuth = (): void => {
    if (authId && progress && !isTerminalStep(progress.step)) {
      cancelMutation({ authId });
    }
  };

  return { progress, isDone, startQrAuth, cancelQrAuth };
}
