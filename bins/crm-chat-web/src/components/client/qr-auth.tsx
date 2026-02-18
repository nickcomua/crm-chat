import { Loader2, RefreshCw, XCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { useQrAuth } from "@/hooks/use-qr-auth";
import { Button } from "../ui/button";

interface QrAuthProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function QrAuth({ onSuccess, onCancel }: QrAuthProps): React.ReactNode {
  const { progress, isDone, startQrAuth, cancelQrAuth } = useQrAuth();
  const hasStartedRef = useRef(false);

  // Keep latest cancelQrAuth in a ref for cleanup
  const cancelRef = useRef(cancelQrAuth);
  useEffect(() => {
    cancelRef.current = cancelQrAuth;
  }, [cancelQrAuth]);

  // Start auth on mount (once)
  useEffect(() => {
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      startQrAuth();
    }
  }, [startQrAuth]);

  // Auto-cancel on unmount
  useEffect(() => {
    return () => {
      cancelRef.current();
    };
  }, []);

  // When task is deleted (isDone), close the dialog
  useEffect(() => {
    if (isDone) {
      onSuccess?.();
    }
  }, [isDone, onSuccess]);

  const step = progress?.step;

  // Track expiration countdown
  const [expiresIn, setExpiresIn] = useState(0);

  useEffect(() => {
    if (step !== "Token" || !progress?.qrExpires) {
      return;
    }

    const expires = progress.qrExpires;

    const updateExpiration = (): void => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, expires - now);
      setExpiresIn(remaining);
    };

    const timeout = setTimeout(updateExpiration, 0);
    const interval = setInterval(updateExpiration, 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [step, progress?.qrExpires]);

  const handleCancel = (): void => {
    cancelQrAuth();
    onCancel?.();
  };

  const handleRetry = (): void => {
    startQrAuth();
  };

  // Loading state
  if (!progress || step === "Pending" || step === "Generating") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-8">
        <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground">Generating QR code...</p>
        <Button onClick={handleCancel} variant="outline">
          Cancel
        </Button>
      </div>
    );
  }

  // QR code token
  if (step === "Token" && progress.qrUrl) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-6">
        <div className="rounded-lg bg-white p-4">
          <QRCodeSVG size={200} value={progress.qrUrl} />
        </div>
        <p className="text-muted-foreground text-sm">
          Scan with Telegram to sign in
        </p>
        {expiresIn > 0 && (
          <p className="text-muted-foreground text-xs">
            Expires in {expiresIn}s
          </p>
        )}
        <Button onClick={handleCancel} variant="outline">
          Cancel
        </Button>
      </div>
    );
  }

  // Cancelled — offer retry
  if (step === "Cancelled") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-8">
        <XCircle className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">Authentication cancelled</p>
        <Button onClick={handleRetry} variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Try Again
        </Button>
      </div>
    );
  }

  return null;
}
