import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import type { Infer } from "spacetimedb";
import { Loader2, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { useTask } from "../../hooks/use-task";
import { type TaskPayload, type GenerateQrCodeOutput } from "../../lib/spacetime";
import { Button } from "../ui/button";

type GenerateQrCodePayload = Infer<typeof TaskPayload> & { tag: "GenerateQrCode" };
type QrCodeOutput = Infer<typeof GenerateQrCodeOutput>;

interface QrAuthProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function QrAuth({ onSuccess, onCancel }: QrAuthProps): React.ReactNode {
  const { createTask, cancelTask, getPayload } = useTask<GenerateQrCodePayload>("GenerateQrCode");
  const [hasStarted, setHasStarted] = useState(false);

  // Start task on mount
  useEffect(() => {
    if (!hasStarted) {
      setHasStarted(true);
      createTask({
        tag: "GenerateQrCode",
        value: { output: { tag: "Pending" } },
      });
    }
  }, [hasStarted, createTask]);

  // Get the current output state
  const payload = getPayload();
  const output: QrCodeOutput | null = payload?.value?.output ?? null;

  // Handle success
  useEffect(() => {
    if (output?.tag === "Authorized" || output?.tag === "AlreadyAuthorized") {
      onSuccess?.();
    }
  }, [output, onSuccess]);

  // Calculate expiration
  const expiresIn = useMemo(() => {
    if (output?.tag === "Token") {
      const now = Math.floor(Date.now() / 1000);
      return Math.max(0, output.value.expires - now);
    }
    return 0;
  }, [output]);

  // Auto-refresh when expired
  useEffect(() => {
    if (output?.tag === "Token" && expiresIn <= 0) {
      // Token expired, create new task
      createTask({
        tag: "GenerateQrCode",
        value: { output: { tag: "Pending" } },
      });
    }
  }, [output, expiresIn, createTask]);

  const handleCancel = () => {
    cancelTask();
    onCancel?.();
  };

  const handleRetry = () => {
    createTask({
      tag: "GenerateQrCode",
      value: { output: { tag: "Pending" } },
    });
  };

  // Render based on output state
  if (!output || output.tag === "Pending") {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground">Generating QR code...</p>
        <Button variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  if (output.tag === "Token") {
    return (
      <div className="flex flex-col items-center justify-center p-6 space-y-4">
        <div className="bg-white p-4 rounded-lg">
          <QRCodeSVG value={output.value.url} size={200} />
        </div>
        <p className="text-sm text-muted-foreground">
          Scan with Telegram to sign in
        </p>
        {expiresIn > 0 && (
          <p className="text-xs text-muted-foreground">
            Expires in {expiresIn}s
          </p>
        )}
        <Button variant="outline" onClick={handleCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  if (output.tag === "Authorized" || output.tag === "AlreadyAuthorized") {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <p className="text-emerald-600 font-medium">Successfully connected!</p>
      </div>
    );
  }

  if (output.tag === "Cancelled") {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <XCircle className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">Authentication cancelled</p>
        <Button variant="outline" onClick={handleRetry}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Try Again
        </Button>
      </div>
    );
  }

  if (output.tag === "Failed") {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <XCircle className="h-12 w-12 text-red-500" />
        <p className="text-red-600 font-medium">Authentication failed</p>
        <p className="text-sm text-muted-foreground">{output.value}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRetry}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
