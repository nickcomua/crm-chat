import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import type { Infer } from "spacetimedb";
import { useQrAuthTask } from "../../hooks/use-task";
import type { GenerateQrCodeOutput } from "../../lib/spacetime";
import { Button } from "../ui/button";

type QrCodeOutput = Infer<typeof GenerateQrCodeOutput>;

interface QrAuthProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function QrAuth({ onSuccess, onCancel }: QrAuthProps): React.ReactNode {
  const { task, startQrAuth, cancelTask } = useQrAuthTask();
  const hasStartedRef = useRef(false);

  // Start task on mount
  useEffect(() => {
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      startQrAuth();
    }
  }, [startQrAuth]);

  // Get the current output state - compute directly from task to ensure reactivity
  const output: QrCodeOutput | null =
    task?.payload?.tag === "GenerateQrCode" ? task.payload.value.output : null;

  // Handle success
  useEffect(() => {
    if (output?.tag === "Authorized" || output?.tag === "AlreadyAuthorized") {
      onSuccess?.();
    }
  }, [output, onSuccess]);

  // Track expiration countdown with interval
  const [expiresIn, setExpiresIn] = useState(0);

  useEffect(() => {
    if (output?.tag !== "Token") {
      return;
    }

    const updateExpiration = (): void => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, output.value.expires - now);
      setExpiresIn(remaining);

      // Auto-refresh when expired
      if (remaining <= 0) {
        startQrAuth();
      }
    };

    // Update immediately (via setTimeout to make it async) and then every second
    const timeout = setTimeout(updateExpiration, 0);
    const interval = setInterval(updateExpiration, 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [output, startQrAuth]);

  const handleCancel = () => {
    cancelTask();
    onCancel?.();
  };

  const handleRetry = () => {
    startQrAuth();
  };

  // Render based on output state
  if (!output || output.tag === "Pending") {
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

  if (output.tag === "Token") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-6">
        <div className="rounded-lg bg-white p-4">
          <QRCodeSVG size={200} value={output.value.url} />
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

  if (output.tag === "Authorized" || output.tag === "AlreadyAuthorized") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-8">
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <p className="font-medium text-emerald-600">Successfully connected!</p>
      </div>
    );
  }

  if (output.tag === "Cancelled") {
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

  if (output.tag === "Failed") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 p-8">
        <XCircle className="h-12 w-12 text-red-500" />
        <p className="font-medium text-red-600">Authentication failed</p>
        <p className="text-muted-foreground text-sm">{output.value}</p>
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
