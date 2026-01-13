import { ArrowLeft, ArrowRight, Loader2, Phone, Shield } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import type { Infer } from "spacetimedb";
import type { Client, DbConnection } from "../lib/spacetime";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type ClientType = Infer<typeof Client>;
const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;
const CODE_REGEX = /^\d{5}$/;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return `+${digits}`;
}

function isValidPhone(normalized: string): boolean {
  return PHONE_REGEX.test(normalized) && normalized.length >= 8;
}

function isValidCode(code: string): boolean {
  return CODE_REGEX.test(code);
}

type Step = "phone" | "code" | "password" | "complete" | "waiting";

// Helper to determine the current step from client status
function getStepFromStatus(client: ClientType | null): Step {
  if (!client) {
    return "phone";
  }

  const status = client.status;

  if (status.tag === "WaitingPhone") {
    if (status.value !== undefined) {
      // Phone submitted, waiting for external service to send code
      return "waiting";
    }
    return "phone";
  }
  if (status.tag === "WaitingCode") {
    if (status.value !== undefined) {
      // Code submitted, waiting for verification
      return "waiting";
    }
    // External service sent code, waiting for user input
    return "code";
  }
  if (status.tag === "WaitingPassword") {
    if (status.value !== undefined) {
      // Password submitted, waiting for verification
      return "waiting";
    }
    // 2FA required, waiting for user input
    return "password";
  }
  if (status.tag === "Connected") {
    return "complete";
  }

  return "phone";
}

// Helper to get a waiting message based on status
function getWaitingMessage(client: ClientType | null): string {
  if (!client) {
    return "";
  }

  const status = client.status;

  if (status.tag === "WaitingPhone" && status.value !== undefined) {
    return "Sending verification code...";
  }
  if (status.tag === "WaitingCode" && status.value !== undefined) {
    return "Verifying code...";
  }
  if (status.tag === "WaitingPassword" && status.value !== undefined) {
    return "Verifying password...";
  }

  return "Processing...";
}

interface AddClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: DbConnection | null;
  pendingClient: ClientType | null;
}

export function AddClientDialog({
  open,
  onOpenChange,
  connection,
  pendingClient,
}: AddClientDialogProps) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState<bigint | null>(null);
  // Track if we just submitted phone and are waiting for backend to process
  const [waitingForBackend, setWaitingForBackend] = useState(false);
  // Track if we just completed the flow (to show success before closing)
  const [justCompleted, setJustCompleted] = useState(false);

  // Derive step from pending client status
  const derivedStep = getStepFromStatus(pendingClient);

  // Determine the current step to display
  // - If we just completed, show complete step even if pendingClient becomes null
  // - If we're waiting for backend after phone submission, show waiting step
  // - Otherwise use the derived step from client status
  const getDisplayStep = (): Step => {
    if (justCompleted) {
      return "complete";
    }
    if (waitingForBackend && derivedStep === "phone") {
      return "waiting";
    }
    return derivedStep;
  };
  const step = getDisplayStep();

  // Reset waitingForBackend when we get a response (step changes from what we were waiting for)
  useEffect(() => {
    if (waitingForBackend && derivedStep !== "phone") {
      setWaitingForBackend(false);
    }
  }, [derivedStep, waitingForBackend]);

  // Detect when client becomes connected and show completion state
  useEffect(() => {
    if (derivedStep === "complete" && !justCompleted && clientId !== null) {
      setJustCompleted(true);
    }
  }, [derivedStep, justCompleted, clientId]);

  // Store the client ID when we have a pending client
  useEffect(() => {
    if (pendingClient) {
      setClientId(pendingClient.id);
      // Pre-fill phone from externalId if available
      if (pendingClient.externalId && !phone) {
        setPhone(pendingClient.externalId);
      }
    }
  }, [pendingClient, phone]);

  const resetForm = () => {
    setPhone("");
    setCode("");
    setPassword("");
    setIsSubmitting(false);
    setError(null);
    setClientId(null);
    setWaitingForBackend(false);
    setJustCompleted(false);
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  const handleSubmitPhone = () => {
    setError(null);
    const normalized = normalizePhone(phone);
    if (!isValidPhone(normalized)) {
      setError(
        "Please enter a valid phone number with country code (e.g. +1... )"
      );
      return;
    }

    if (!(normalized && connection?.identity)) {
      return;
    }
    setIsSubmitting(true);
    setWaitingForBackend(true);

    const newClientId = clientId ?? BigInt(Date.now());
    setClientId(newClientId);

    connection.reducers.upsertClient({
      client: {
        id: 0n,
        ownerUserId: connection.identity,
        kind: { tag: "Telegram" },
        externalId: normalized,
        activeChats: [],
        status: { tag: "WaitingPhone", value: normalized },
        session: "",
      },
    });

    // Reset submitting state after a short delay (button loading)
    // waitingForBackend will keep showing the waiting step until backend responds
    setTimeout(() => setIsSubmitting(false), 500);
  };

  const handleSubmitCode = () => {
    setError(null);
    const trimmedCode = code.trim();
    if (!isValidCode(trimmedCode)) {
      setError("Verification code must be 5 digits");
      return;
    }

    if (!(trimmedCode && connection && pendingClient)) {
      return;
    }
    setIsSubmitting(true);

    connection.reducers.upsertClient({
      client: {
        ...pendingClient,
        status: { tag: "WaitingCode", value: trimmedCode },
      },
    });

    setTimeout(() => setIsSubmitting(false), 500);
  };

  const handleSubmitPassword = () => {
    if (!(password.trim() && connection && pendingClient)) {
      return;
    }
    setIsSubmitting(true);

    connection.reducers.upsertClient({
      client: {
        ...pendingClient,
        status: { tag: "WaitingPassword", value: password.trim() },
      },
    });

    setTimeout(() => setIsSubmitting(false), 500);
  };

  const handleSkipPassword = () => {
    if (!(connection && pendingClient)) {
      return;
    }
    setIsSubmitting(true);

    // Submit with empty password to indicate skip
    connection.reducers.upsertClient({
      client: {
        ...pendingClient,
        status: { tag: "WaitingPassword", value: "" },
      },
    });

    setTimeout(() => setIsSubmitting(false), 500);
  };

  const handleDeletePendingClient = () => {
    if (!(connection && pendingClient)) {
      return;
    }
    connection.reducers.deleteClient({ clientId: pendingClient.id });
    handleClose();
  };

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Telegram Client</DialogTitle>
          <DialogDescription>
            {step === "phone" && "Enter your phone number to get started"}
            {step === "code" &&
              "Enter the verification code sent to your phone"}
            {step === "password" &&
              "Enter your two-factor authentication password"}
            {step === "complete" && "Your Telegram client has been added"}
            {step === "waiting" && getWaitingMessage(pendingClient)}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4">
          {step === "phone" && (
            <PhoneStep
              error={error}
              isLoading={isSubmitting}
              onSubmit={handleSubmitPhone}
              phone={phone}
              setPhone={(p) => {
                setPhone(p);
                setError(null);
              }}
            />
          )}

          {step === "code" && (
            <CodeStep
              code={code}
              error={error}
              isLoading={isSubmitting}
              onBack={handleDeletePendingClient}
              onSubmit={handleSubmitCode}
              setCode={(c) => {
                setCode(c);
                setError(null);
              }}
            />
          )}

          {step === "password" && (
            <PasswordStep
              isLoading={isSubmitting}
              onBack={handleDeletePendingClient}
              onSkip={handleSkipPassword}
              onSubmit={handleSubmitPassword}
              password={password}
              setPassword={setPassword}
            />
          )}

          {step === "waiting" && (
            <WaitingStep
              message={
                getWaitingMessage(pendingClient) ||
                "Sending verification code..."
              }
            />
          )}

          {step === "complete" && <CompleteStep onClose={handleClose} />}
        </div>

        <StepIndicator currentStep={step} />
      </DialogContent>
    </Dialog>
  );
}

function PhoneStep({
  phone,
  setPhone,
  isLoading,
  onSubmit,
  error,
}: {
  phone: string;
  setPhone: (phone: string) => void;
  isLoading: boolean;
  onSubmit: () => void;
  error: string | null;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="phone">Phone Number</Label>
        <div className="relative">
          <Phone className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className={`pl-10 ${error ? "border-destructive focus-visible:ring-destructive" : ""}`}
            disabled={isLoading}
            id="phone"
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="+1 234 567 8900"
            type="tel"
            value={phone}
          />
        </div>
        {error ? (
          <p className="font-medium text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Include your country code (e.g., +1 for US)
          </p>
        )}
      </div>
      <Button
        className="w-full"
        disabled={!phone.trim() || isLoading}
        onClick={onSubmit}
      >
        {isLoading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <ArrowRight className="mr-2 h-4 w-4" />
        )}
        Send Code
      </Button>
    </div>
  );
}

function CodeStep({
  code,
  setCode,
  isLoading,
  onSubmit,
  onBack,
  error,
}: {
  code: string;
  setCode: (code: string) => void;
  isLoading: boolean;
  onSubmit: () => void;
  onBack: () => void;
  error: string | null;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="code">Verification Code</Label>
        <Input
          className={`text-center text-2xl tracking-widest ${error ? "border-destructive focus-visible:ring-destructive" : ""}`}
          disabled={isLoading}
          id="code"
          maxLength={5}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="12345"
          type="text"
          value={code}
        />
        {error ? (
          <p className="font-medium text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Check your Telegram app for the login code
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button disabled={isLoading} onClick={onBack} variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Cancel
        </Button>
        <Button
          className="flex-1"
          disabled={!code.trim() || isLoading}
          onClick={onSubmit}
        >
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="mr-2 h-4 w-4" />
          )}
          Verify
        </Button>
      </div>
    </div>
  );
}

function PasswordStep({
  password,
  setPassword,
  isLoading,
  onSubmit,
  onSkip,
  onBack,
}: {
  password: string;
  setPassword: (password: string) => void;
  isLoading: boolean;
  onSubmit: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">Two-Factor Password</Label>
        <div className="relative">
          <Shield className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-10"
            disabled={isLoading}
            id="password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter your 2FA password"
            type="password"
            value={password}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          If you have two-factor authentication enabled, enter your password
        </p>
      </div>
      <div className="flex gap-2">
        <Button disabled={isLoading} onClick={onBack} variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Cancel
        </Button>
        <Button disabled={isLoading} onClick={onSkip} variant="ghost">
          Skip
        </Button>
        <Button className="flex-1" disabled={isLoading} onClick={onSubmit}>
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="mr-2 h-4 w-4" />
          )}
          Submit
        </Button>
      </div>
    </div>
  );
}

function WaitingStep({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center space-y-4 py-8">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
}

function CompleteStep({ onClose }: { onClose: () => void }) {
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

function StepIndicator({ currentStep }: { currentStep: Step }) {
  const steps: Step[] = ["phone", "code", "password", "complete"];
  const stepIndex = {
    phone: 0,
    code: 1,
    password: 2,
    complete: 3,
    waiting: -1, // Special case, will use the previous step's index
  };

  // For waiting state, we show progress based on what we're waiting for
  const currentIndex = currentStep === "waiting" ? 1 : stepIndex[currentStep];

  return (
    <div className="mt-6 flex justify-center gap-2">
      {steps.map((step, index) => (
        <div
          className={`h-1.5 w-8 rounded-full transition-colors ${
            index <= currentIndex ? "bg-primary" : "bg-muted"
          }`}
          key={step}
        />
      ))}
    </div>
  );
}
