import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { Infer } from "spacetimedb";
import { useSpacetimeDB } from "spacetimedb/react";
import { useTask } from "../../hooks/use-task";
import type {
  DbConnection,
  ReceiveLoginCode,
  ReceiveLoginCodeOutput,
} from "../../lib/spacetime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface ReceiveLoginCodePayload {
  tag: "ReceiveLoginCode";
  value: Infer<typeof ReceiveLoginCode>;
}

type ReceiveLoginCodeOutputType = Infer<typeof ReceiveLoginCodeOutput>;

const CODE_REGEX = /^\d{5}$/;

function isValidCode(code: string): boolean {
  return CODE_REGEX.test(code);
}

interface ReceiveLoginCodeTaskProps {
  taskId: string;
  onAbort: () => void;
}

export function ReceiveLoginCodeTask({
  taskId,
  onAbort,
}: ReceiveLoginCodeTaskProps): React.ReactNode {
  const [code, setCode] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { getConnection } = useSpacetimeDB();
  const conn = getConnection<DbConnection>();
  const { task } = useTask<ReceiveLoginCodePayload>({ id: taskId });

  const output = task?.payload.value.output as
    | ReceiveLoginCodeOutputType
    | undefined;

  const handleSubmit = (): void => {
    setValidationError(null);
    const trimmedCode = code.trim();
    if (!isValidCode(trimmedCode)) {
      setValidationError("Verification code must be 5 digits");
      return;
    }

    if (!conn) {
      return;
    }

    if (!task) {
      return;
    }

    setIsSubmitting(true);
    // Complete the user task with the code
    conn.reducers.completeTask({
      taskId,
      payload: {
        tag: "ReceiveLoginCode",
        value: {
          clientPhone: task.payload.value.clientPhone,
          token: task.payload.value.token,
          output: { tag: "Success", value: trimmedCode },
        },
      },
    });
  };

  const handleAbort = (): void => {
    if (!conn) {
      onAbort();
      return;
    }

    if (!task) {
      onAbort();
      return;
    }

    conn.reducers.completeTask({
      taskId,
      payload: {
        tag: "ReceiveLoginCode",
        value: {
          clientPhone: task.payload.value.clientPhone,
          token: task.payload.value.token,
          output: { tag: "Aborted" },
        },
      },
    });
    onAbort();
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (!task || output?.tag !== "Pending") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground text-sm">Loading...</p>
      </div>
    );
  }

  if (isSubmitting) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 py-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground text-sm">Submitting code...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="code">Verification Code</Label>
        <Input
          className={`text-center text-2xl tracking-widest ${validationError ? "border-destructive focus-visible:ring-destructive" : ""}`}
          id="code"
          maxLength={5}
          onChange={(e) => {
            setCode(e.target.value);
            setValidationError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder="12345"
          type="text"
          value={code}
        />
        {validationError ? (
          <p className="font-medium text-destructive text-xs">
            {validationError}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Check your Telegram app for the login code
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={handleAbort} variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Cancel
        </Button>
        <Button
          className="flex-1"
          disabled={!code.trim()}
          onClick={handleSubmit}
        >
          <ArrowRight className="mr-2 h-4 w-4" />
          Verify
        </Button>
      </div>
    </div>
  );
}
