import { Loader2, QrCode, Smartphone } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { Infer } from "spacetimedb";
import { useTable } from "spacetimedb/react";
import type { Client } from "../lib/spacetime";
import { tables } from "../lib/spacetime";
import { GenerateQrCodeTask } from "./client/generate-qr-code-task";
import { ReceiveLoginCodeTask } from "./client/receive-login-code-task";
import { ReceivePasswordTask } from "./client/receive-password-task";
import { SendLoginCodeTask } from "./client/send-login-code-task";
import type { GenerateQrCodeResult, SendLoginCodeResult } from "./client/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type FlowType = "choose" | "phone" | "qr";

interface AddClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional clientId to resume an existing client's auth flow */
  resumeClientId?: bigint;
}

export function AddClientDialog({
  open,
  onOpenChange,
  resumeClientId,
}: AddClientDialogProps): React.ReactNode {
  const [flowType, setFlowType] = useState<FlowType>("choose");

  // If resumeClientId is provided, we're in phone flow mode (resuming)
  const isResuming = resumeClientId !== undefined;
  const effectiveFlowType = isResuming ? "phone" : flowType;

  const handleClose = (): void => {
    setFlowType("choose");
    onOpenChange(false);
  };

  const handleChoosePhone = (): void => {
    setFlowType("phone");
  };

  const handleChooseQr = (): void => {
    setFlowType("qr");
  };

  const handleBackToChoose = (): void => {
    setFlowType("choose");
  };

  const getDescription = (): string => {
    if (isResuming) {
      return "Continue authentication";
    }
    switch (effectiveFlowType) {
      case "choose":
        return "Choose how you want to log in";
      case "phone":
        return "Enter your phone number to get started";
      case "qr":
        return "Scan the QR code with your Telegram app";
      default: {
        const _exhaustive: never = effectiveFlowType;
        return _exhaustive;
      }
    }
  };

  const renderContent = (): React.ReactNode => {
    switch (effectiveFlowType) {
      case "choose":
        return (
          <ChooseMethodStep
            onChoosePhone={handleChoosePhone}
            onChooseQr={handleChooseQr}
          />
        );
      case "phone":
        return (
          <PhoneAuthFlow
            onBack={isResuming ? handleClose : handleBackToChoose}
            onComplete={handleClose}
            resumeClientId={resumeClientId}
          />
        );
      case "qr":
        return (
          <QrCodeAuthFlow
            onBack={handleBackToChoose}
            onComplete={handleClose}
          />
        );
      default: {
        const _exhaustive: never = effectiveFlowType;
        return _exhaustive;
      }
    }
  };

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isResuming ? "Continue Authentication" : "Add Telegram Client"}
          </DialogTitle>
          <DialogDescription>{getDescription()}</DialogDescription>
        </DialogHeader>

        <div className="mt-4">{renderContent()}</div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// QR Code Auth Flow - Self-contained, no client state tracking needed
// =============================================================================

interface QrCodeAuthFlowProps {
  onBack: () => void;
  onComplete: () => void;
}

function QrCodeAuthFlow({
  onBack,
  onComplete,
}: QrCodeAuthFlowProps): React.ReactNode {
  const [isComplete, setIsComplete] = useState(false);

  const handleResult = (result: GenerateQrCodeResult): void => {
    if (
      result.status === "authorized" ||
      result.status === "already_authorized"
    ) {
      setIsComplete(true);
    }
    // For "token" status, the GenerateQrCodeTask handles displaying the QR
    // For "failed" status, the GenerateQrCodeTask handles displaying the error
  };

  if (isComplete) {
    return <CompleteStep onClose={onComplete} />;
  }

  return <GenerateQrCodeTask onBack={onBack} onResult={handleResult} />;
}

// =============================================================================
// Phone Auth Flow - Uses client from SpacetimeDB for state management
// =============================================================================

interface PhoneAuthFlowProps {
  onBack: () => void;
  onComplete: () => void;
  /** Optional clientId to resume an existing client's auth flow */
  resumeClientId?: bigint;
}

type PhoneAuthStep =
  | { type: "enter_phone" }
  | { type: "tracking_by_id"; clientId: bigint }
  | { type: "tracking_by_phone"; clientPhone: string };

function PhoneAuthFlow({
  onBack,
  onComplete,
  resumeClientId,
}: PhoneAuthFlowProps): React.ReactNode {
  const [clients] = useTable(tables.client);
  const [step, setStep] = useState<PhoneAuthStep>(
    resumeClientId !== undefined
      ? { type: "tracking_by_id", clientId: resumeClientId }
      : { type: "enter_phone" }
  );

  // Find client based on tracking method
  const client: Infer<typeof Client> | undefined = (() => {
    switch (step.type) {
      case "tracking_by_id":
        return clients.find((c) => c.id === step.clientId);
      case "tracking_by_phone":
        return clients.find((c) => c.externalId === step.clientPhone);
      default:
        return undefined;
    }
  })();

  const handleSendLoginCodeResult = (
    result: SendLoginCodeResult,
    phone: string
  ): void => {
    if (result.status === "success") {
      // Start tracking the client by phone number
      setStep({ type: "tracking_by_phone", clientPhone: phone });
    } else if (result.status === "already_authorized") {
      // Client already exists and is authorized
      onComplete();
    }
    // For "failed" status, SendLoginCodeTask handles displaying the error
  };

  const handleAbort = (): void => {
    setStep({ type: "enter_phone" });
  };

  // Step 1: Enter phone number
  if (step.type === "enter_phone") {
    return (
      <SendLoginCodeTask onBack={onBack} onResult={handleSendLoginCodeResult} />
    );
  }

  // Step 2+: Track client status from SpacetimeDB
  // Waiting for client to appear in the database
  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground text-sm">
          Setting up authentication...
        </p>
      </div>
    );
  }

  // Render based on client status
  return (
    <PhoneAuthClientStatus
      client={client}
      onAbort={handleAbort}
      onComplete={onComplete}
    />
  );
}

// Sub-component to render UI based on client status
interface PhoneAuthClientStatusProps {
  client: Infer<typeof Client>;
  onAbort: () => void;
  onComplete: () => void;
}

function PhoneAuthClientStatus({
  client,
  onAbort,
  onComplete,
}: PhoneAuthClientStatusProps): React.ReactNode {
  const { status } = client;

  switch (status.tag) {
    case "Connected":
      return <CompleteStep onClose={onComplete} />;

    case "ReceivingLoginCode":
      return <ReceiveLoginCodeTask onAbort={onAbort} taskId={status.value} />;

    case "ReceivingPassword":
      return <ReceivePasswordTask onAbort={onAbort} taskId={status.value} />;

    case "Error":
      return (
        <div className="space-y-4 text-center">
          <p className="text-destructive">{status.value}</p>
          <Button onClick={onAbort} variant="outline">
            Try Again
          </Button>
        </div>
      );

    // Loading states: SendingLoginCode, VerifyingLoginCode, VerifyingPassword
    default:
      return (
        <div className="flex flex-col items-center justify-center space-y-4 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground text-sm">
            {getStatusDescription(status.tag)}
          </p>
        </div>
      );
  }
}

function getStatusDescription(statusTag: string): string {
  switch (statusTag) {
    case "SendingLoginCode":
      return "Sending verification code...";
    case "VerifyingLoginCode":
      return "Verifying code...";
    case "VerifyingPassword":
      return "Verifying password...";
    default:
      return "Processing...";
  }
}

// =============================================================================
// Shared Components
// =============================================================================

function ChooseMethodStep({
  onChoosePhone,
  onChooseQr,
}: {
  onChoosePhone: () => void;
  onChooseQr: () => void;
}): React.ReactNode {
  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        <Button
          className="h-auto flex-col gap-2 py-4"
          onClick={onChooseQr}
          variant="outline"
        >
          <QrCode className="h-8 w-8" />
          <div className="text-center">
            <div className="font-medium">Scan QR Code</div>
            <div className="text-muted-foreground text-xs">
              Quick login with another device
            </div>
          </div>
        </Button>
        <Button
          className="h-auto flex-col gap-2 py-4"
          onClick={onChoosePhone}
          variant="outline"
        >
          <Smartphone className="h-8 w-8" />
          <div className="text-center">
            <div className="font-medium">Phone Number</div>
            <div className="text-muted-foreground text-xs">
              Login with SMS verification code
            </div>
          </div>
        </Button>
      </div>
    </div>
  );
}

function CompleteStep({ onClose }: { onClose: () => void }): React.ReactNode {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
        <svg
          aria-label="Success checkmark"
          className="h-6 w-6 text-emerald-600 dark:text-emerald-400"
          fill="none"
          role="img"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            d="M5 13l4 4L19 7"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        </svg>
      </div>
      <div>
        <h3 className="font-medium text-lg">Success!</h3>
        <p className="mt-1 text-muted-foreground text-sm">
          Your Telegram client has been successfully connected.
        </p>
      </div>
      <Button className="w-full" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}
