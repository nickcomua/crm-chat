import { ArrowLeft, ArrowRight, Loader2, Phone } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { Infer } from "spacetimedb";
import { useTask } from "../../hooks/use-task";
import type { SendLoginCode, SendLoginCodeOutput } from "../../lib/spacetime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { SendLoginCodeResult } from "./types";

interface SendLoginCodePayload {
  tag: "SendLoginCode";
  value: Infer<typeof SendLoginCode>;
}

type SendLoginCodeOutputType = Infer<typeof SendLoginCodeOutput>;

const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return `+${digits}`;
}

function isValidPhone(normalized: string): boolean {
  return PHONE_REGEX.test(normalized) && normalized.length >= 8;
}

interface SendLoginCodeTaskProps {
  onResult: (result: SendLoginCodeResult, phone: string) => void;
  onBack: () => void;
}

export function SendLoginCodeTask({
  onResult,
  onBack,
}: SendLoginCodeTaskProps): React.ReactNode {
  const [phone, setPhone] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const normalizedPhone = normalizePhone(phone);
  const { createTask, task } = useTask<SendLoginCodePayload>();

  // Derive state from task
  const output = task?.payload.value.output as
    | SendLoginCodeOutputType
    | undefined;
  const isSubmitting = hasSubmitted && (!task || output?.tag === "Pending");
  const taskError = output?.tag === "Failed" ? output.value : null;
  const error = validationError ?? taskError;

  // Handle task output changes
  if (output && output.tag !== "Pending" && output.tag !== "Failed") {
    if (output.tag === "Success") {
      onResult(
        { status: "success", loginToken: output.value },
        normalizedPhone
      );
    } else if (output.tag === "AlreadyAuthorized") {
      onResult({ status: "already_authorized" }, normalizedPhone);
    }
  }

  const handleSubmit = (): void => {
    setValidationError(null);
    const normalized = normalizePhone(phone);
    if (!isValidPhone(normalized)) {
      setValidationError(
        "Please enter a valid phone number with country code (e.g. +1... )"
      );
      return;
    }

    setHasSubmitted(true);
    createTask({
      tag: "SendLoginCode",
      value: { clientPhone: normalized, output: { tag: "Pending" } },
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (isSubmitting) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground text-sm">
          Sending verification code...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="phone">Phone Number</Label>
        <div className="relative">
          <Phone className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className={`pl-10 ${error ? "border-destructive focus-visible:ring-destructive" : ""}`}
            disabled={isSubmitting}
            id="phone"
            onChange={(e) => {
              setPhone(e.target.value);
              setValidationError(null);
            }}
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
      <div className="flex gap-2">
        <Button disabled={isSubmitting} onClick={onBack} variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={!phone.trim() || isSubmitting}
          onClick={handleSubmit}
        >
          <ArrowRight className="mr-2 h-4 w-4" />
          Send Code
        </Button>
      </div>
    </div>
  );
}
