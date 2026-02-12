import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { useQrAuth } from "@/hooks/use-qr-auth";
import { Button } from "../ui/button";

interface QrAuthProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function QrAuth({ onSuccess, onCancel }: QrAuthProps): React.ReactNode {
  const { auth, startQrAuth, cancelQrAuth } = useQrAuth();
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

  const step = auth?.step;

  // Handle success
  useEffect(() => {
    if (step === "Authorized" || step === "AlreadyAuthorized") {
      onSuccess?.();
    }
  }, [step, onSuccess]);

  // Track expiration countdown
  const [expiresIn, setExpiresIn] = useState(0);

  useEffect(() => {
    if (step !== "Token" || !auth?.qrExpires) {
      return;
    }

    const expires = auth.qrExpires;

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
  }, [step, auth?.qrExpires]);

  const handleCancel = (): void => {
    cancelQrAuth();
    onCancel?.();
  };

  const handleRetry = (): void => {
    startQrAuth();
  };

  // Loading state
  if (!auth || step === "Pending" || step === "Generating") {
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
  if (step === "Token" && auth.qrUrl) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-6">
        <div className="rounded-lg bg-white p-4">
          <QRCodeSVG size={200} value={auth.qrUrl} />
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

  // Success
  if (step === "Authorized" || step === "AlreadyAuthorized") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-8">
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <p className="font-medium text-emerald-600">Successfully connected!</p>
      </div>
    );
  }

  // Cancelled
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

  // Failed
  if (step === "Failed") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-8">
        <XCircle className="h-12 w-12 text-red-500" />
        <p className="font-medium text-red-600">Authentication failed</p>
        <p className="text-muted-foreground text-sm">{auth.error}</p>
        <div className="flex gap-2">
          <Button onClick={handleRetry} variant="outline">
            <RefreshCw className="mr-2 h-4 w-4" />
            Try Again
          </Button>
          <Button onClick={handleCancel} variant="ghost">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
