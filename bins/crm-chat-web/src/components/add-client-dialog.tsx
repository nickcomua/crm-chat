import { Loader2, QrCode, Smartphone } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTable } from "spacetimedb/react";
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

type Step =
  | { type: "choose" }
  | { type: "phone" }
  | { type: "qr" }
  | { type: "complete" };

const CLIENT_STATUS_DESCRIPTIONS: Record<string, string> = {
  SendingLoginCode: "Sending verification code...",
  ReceivingLoginCode: "Enter the verification code sent to your phone",
  VerifyingLoginCode: "Verifying code...",
  ReceivingPassword: "Enter your two-factor authentication password",
  VerifyingPassword: "Verifying password...",
  GeneratingQrCode: "Scan the QR code with your Telegram app",
  Connected: "Your Telegram client has been added",
};

const STEP_DESCRIPTIONS: Record<Step["type"], string> = {
  choose: "Choose how you want to log in",
  phone: "Enter your phone number to get started",
  qr: "Scan the QR code with your Telegram app",
  complete: "Your Telegram client has been added",
};

interface AddClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddClientDialog({
  open,
  onOpenChange,
}: AddClientDialogProps): React.ReactNode {
  const [step, setStep] = useState<Step>({ type: "choose" });
  const [activePhone, setActivePhone] = useState<string | null>(null);

  // Watch for clients to track authentication progress
  const [clients] = useTable(tables.client);

  // Find the client being authenticated (if any)
  const activeClient = activePhone
    ? clients.find((c) => c.externalId === activePhone)
    : null;

  const handleClose = (): void => {
    setStep({ type: "choose" });
    setActivePhone(null);
    onOpenChange(false);
  };

  const handleChoosePhone = (): void => {
    setStep({ type: "phone" });
  };

  const handleChooseQr = (): void => {
    setStep({ type: "qr" });
  };

  const handleBackToChoose = (): void => {
    setStep({ type: "choose" });
    setActivePhone(null);
  };

  const handleSendLoginCodeResult = (
    result: SendLoginCodeResult,
    phone: string
  ): void => {
    if (result.status === "success") {
      // Backend will create client with status tracking the task
      // We just need to track which phone we're authenticating
      setActivePhone(phone);
    } else if (result.status === "already_authorized") {
      setStep({ type: "complete" });
    }
  };

  const handleQrCodeResult = (result: GenerateQrCodeResult): void => {
    if (
      result.status === "already_authorized" ||
      result.status === "authorized"
    ) {
      setStep({ type: "complete" });
    }
  };

  const handleAbort = (): void => {
    handleBackToChoose();
  };

  // Determine what to render based on client status
  const getDialogDescription = (): string => {
    if (activeClient) {
      const { tag } = activeClient.status;
      if (tag === "Error") {
        return `Error: ${activeClient.status.value}`;
      }
      return CLIENT_STATUS_DESCRIPTIONS[tag] ?? "";
    }
    return STEP_DESCRIPTIONS[step.type];
  };

  // Render content based on active client status
  const renderClientContent = (): React.ReactNode => {
    if (!activeClient) {
      return null;
    }

    const status = activeClient.status;

    switch (status.tag) {
      case "Connected":
        return <CompleteStep onClose={handleClose} />;
      case "ReceivingLoginCode":
        return (
          <ReceiveLoginCodeTask onAbort={handleAbort} taskId={status.value} />
        );
      case "ReceivingPassword":
        return (
          <ReceivePasswordTask onAbort={handleAbort} taskId={status.value} />
        );
      case "Error":
        return (
          <div className="space-y-4 text-center">
            <p className="text-destructive">{status.value}</p>
            <Button onClick={handleBackToChoose} variant="outline">
              Try Again
            </Button>
          </div>
        );
      default:
        // Robot tasks: show loading state
        return (
          <div className="flex flex-col items-center justify-center space-y-4 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground text-sm">Processing...</p>
          </div>
        );
    }
  };

  // Render content based on step (when no active client)
  const renderStepContent = (): React.ReactNode => {
    switch (step.type) {
      case "choose":
        return (
          <ChooseMethodStep
            onChoosePhone={handleChoosePhone}
            onChooseQr={handleChooseQr}
          />
        );
      case "phone":
        return (
          <SendLoginCodeTask
            onBack={handleBackToChoose}
            onResult={handleSendLoginCodeResult}
          />
        );
      case "qr":
        return (
          <GenerateQrCodeTask
            onBack={handleBackToChoose}
            onResult={handleQrCodeResult}
          />
        );
      case "complete":
        return <CompleteStep onClose={handleClose} />;
      default:
        return null;
    }
  };

  const renderContent = (): React.ReactNode => {
    return activeClient ? renderClientContent() : renderStepContent();
  };

  // Get step for progress indicator
  const getCurrentStepType = (): Step["type"] => {
    if (activeClient) {
      const { tag } = activeClient.status;
      switch (tag) {
        case "SendingLoginCode":
        case "ReceivingLoginCode":
        case "VerifyingLoginCode":
        case "ReceivingPassword":
        case "VerifyingPassword":
          return "phone";
        case "GeneratingQrCode":
          return "qr";
        case "Connected":
          return "complete";
        default:
          return "choose";
      }
    }
    return step.type;
  };

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Telegram Client</DialogTitle>
          <DialogDescription>{getDialogDescription()}</DialogDescription>
        </DialogHeader>

        <div className="mt-4">{renderContent()}</div>

        <StepIndicator currentStep={getCurrentStepType()} />
      </DialogContent>
    </Dialog>
  );
}

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

function StepIndicator({
  currentStep,
}: {
  currentStep: Step["type"];
}): React.ReactNode {
  const steps: Step["type"][] = ["choose", "phone", "complete"];

  const getStepIndex = (step: Step["type"]): number => {
    if (step === "qr") {
      return 1; // QR is equivalent to phone step in the indicator
    }
    const index = steps.indexOf(step);
    return index >= 0 ? index : 0;
  };

  const currentIndex = getStepIndex(currentStep);

  return (
    <div className="mt-6 flex justify-center gap-2">
      {steps.map((step, index) => (
        <div
          className={`h-1.5 w-8 rounded-full transition-colors ${index <= currentIndex ? "bg-primary" : "bg-muted"}`}
          key={step}
        />
      ))}
    </div>
  );
}
