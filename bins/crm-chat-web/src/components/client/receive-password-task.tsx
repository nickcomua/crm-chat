import { ArrowLeft, ArrowRight, Loader2, Shield } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { Infer } from "spacetimedb";
import { useSpacetimeDB } from "spacetimedb/react";
import { useWatchTask } from "../../hooks/use-task";
import type {
  DbConnection,
  ReceivePassword,
  ReceivePasswordOutput,
} from "../../lib/spacetime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface ReceivePasswordPayload {
  tag: "ReceivePassword";
  value: Infer<typeof ReceivePassword>;
}

type ReceivePasswordOutputType = Infer<typeof ReceivePasswordOutput>;

interface ReceivePasswordTaskProps {
  taskId: string;
  onAbort: () => void;
}

export function ReceivePasswordTask({
  taskId,
  onAbort,
}: ReceivePasswordTaskProps): React.ReactNode {
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { getConnection } = useSpacetimeDB();
  const conn = getConnection<DbConnection>();
  const task = useWatchTask<ReceivePasswordPayload>(taskId);

  const output = task?.payload.value.output as
    | ReceivePasswordOutputType
    | undefined;
  const hint = task?.payload.value.hint;

  const handleSubmit = (pwd: string): void => {
    if (!conn) {
      return;
    }

    if (!task) {
      return;
    }

    setIsSubmitting(true);
    conn.reducers.completeTask({
      taskId,
      payload: {
        tag: "ReceivePassword",
        value: {
          clientPhone: task.payload.value.clientPhone,
          hint: task.payload.value.hint,
          token: task.payload.value.token,
          output: { tag: "Success", value: pwd },
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
        tag: "ReceivePassword",
        value: {
          clientPhone: task.payload.value.clientPhone,
          hint: task.payload.value.hint,
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
      handleSubmit(password.trim());
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
        <p className="text-muted-foreground text-sm">Verifying password...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">Two-Factor Password</Label>
        <div className="relative">
          <Shield className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-10"
            id="password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter your 2FA password"
            type="password"
            value={password}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {hint
            ? `Hint: ${hint}`
            : "Enter your two-factor authentication password"}
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleAbort} variant="outline">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Cancel
        </Button>
        <Button onClick={() => handleSubmit("")} variant="ghost">
          Skip
        </Button>
        <Button
          className="flex-1"
          onClick={() => handleSubmit(password.trim())}
        >
          <ArrowRight className="mr-2 h-4 w-4" />
          Submit
        </Button>
      </div>
    </div>
  );
}
