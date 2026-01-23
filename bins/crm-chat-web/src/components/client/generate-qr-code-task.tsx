import { ArrowLeft, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { Infer } from "spacetimedb";
import { useTaskWithCleanup } from "../../hooks/use-task";
import type {
  GenerateQrCode,
  GenerateQrCodeOutput,
  QrToken,
} from "../../lib/spacetime";
import { Button } from "../ui/button";
import type { GenerateQrCodeResult } from "./types";

interface GenerateQrCodePayload {
  tag: "GenerateQrCode";
  value: Infer<typeof GenerateQrCode>;
}

type GenerateQrCodeOutputType = Infer<typeof GenerateQrCodeOutput>;
type QrTokenType = Infer<typeof QrToken>;

interface GenerateQrCodeTaskProps {
  onResult: (result: GenerateQrCodeResult) => void;
  onBack: () => void;
}

export function GenerateQrCodeTask({
  onResult,
  onBack,
}: GenerateQrCodeTaskProps): React.ReactNode {
  const [hasCreated, setHasCreated] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expirationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTokenUrlRef = useRef<string | null>(null);

  const { createTask, task, cancelTask } =
    useTaskWithCleanup<GenerateQrCodePayload>();

  // Create task on mount (using state to track if we've created it)
  if (!hasCreated) {
    createTask({
      tag: "GenerateQrCode",
      value: { output: { tag: "Pending" } },
    });
    setHasCreated(true);
  }

  // Handle task output changes
  const output = task?.payload.value.output as
    | GenerateQrCodeOutputType
    | undefined;

  // Update QR code when token changes
  useEffect(() => {
    if (!output || output.tag === "Pending") {
      return;
    }

    if (output.tag === "Token") {
      const qrToken = output.value as QrTokenType;

      // Only update if URL actually changed
      if (lastTokenUrlRef.current === qrToken.url) {
        return;
      }
      lastTokenUrlRef.current = qrToken.url;

      // Clear any existing expiration timer
      if (expirationTimerRef.current) {
        clearTimeout(expirationTimerRef.current);
      }

      setQrUrl(qrToken.url);
      setIsExpired(false);

      // Set up expiration timer
      // expires is a Unix timestamp in seconds
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = (qrToken.expires - now) * 1000;

      if (expiresIn > 0) {
        expirationTimerRef.current = setTimeout(() => {
          setIsExpired(true);
        }, expiresIn);
      } else {
        setIsExpired(true);
      }

      onResult({ status: "token", url: qrToken.url, expires: qrToken.expires });
    } else if (output.tag === "Authorized") {
      onResult({ status: "authorized", signIn: output.value });
    } else if (output.tag === "AlreadyAuthorized") {
      // AlreadyAuthorized may or may not have a value depending on bindings version
      const signIn =
        "value" in output
          ? (output.value as { userId: bigint })
          : { userId: BigInt(0) };
      onResult({ status: "already_authorized", signIn });
    } else if (output.tag === "Failed") {
      setError(output.value);
      onResult({ status: "failed", error: output.value });
    }
  }, [output, onResult]);

  // Cleanup expiration timer on unmount
  useEffect(() => {
    return () => {
      if (expirationTimerRef.current) {
        clearTimeout(expirationTimerRef.current);
      }
    };
  }, []);

  const handleBack = (): void => {
    cancelTask();
    onBack();
  };

  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-4">
          <p className="font-medium text-destructive text-sm">{error}</p>
        </div>
        <Button className="w-full" onClick={handleBack} variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to login options
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-4">
        {qrUrl ? (
          <div
            className={`rounded-lg border bg-white p-4 ${isExpired ? "opacity-50" : ""}`}
          >
            <QRCodeSVG
              bgColor="#ffffff"
              fgColor="#000000"
              level="M"
              size={200}
              value={qrUrl}
            />
          </div>
        ) : (
          <div className="flex h-[232px] w-[232px] items-center justify-center rounded-lg border">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        <div className="space-y-2 text-center">
          {isExpired ? (
            <p className="font-medium text-amber-600 text-sm">
              QR code expired. Waiting for new code...
            </p>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">
                Open Telegram on your phone
              </p>
              <p className="text-muted-foreground text-sm">
                Go to{" "}
                <span className="font-medium">
                  Settings → Devices → Link Desktop Device
                </span>
              </p>
              <p className="text-muted-foreground text-sm">
                Point your phone at this screen to confirm login
              </p>
            </>
          )}
        </div>
      </div>
      <Button className="w-full" onClick={handleBack} variant="outline">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to login options
      </Button>
    </div>
  );
}
