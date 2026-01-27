import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Infer } from "spacetimedb";
import { useReducer, useTable } from "spacetimedb/react";
import { type Client, reducers, tables } from "../lib/spacetime";
import { AddClientDialog } from "./add-client-dialog";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";

type ClientType = Infer<typeof Client>;

// Helper to check if a client is connected
function isClientConnected(client: ClientType): boolean {
  return client.status.tag === "Connected";
}

// Helper to check if a client is in authentication state (any task-based state)
function isClientAuthenticating(client: ClientType): boolean {
  const { tag } = client.status;
  return (
    tag === "SendingLoginCode" ||
    tag === "ReceivingLoginCode" ||
    tag === "VerifyingLoginCode" ||
    tag === "ReceivingPassword" ||
    tag === "VerifyingPassword" ||
    tag === "GeneratingQrCode"
  );
}

// Helper to check if a client has an error
function isClientError(client: ClientType): boolean {
  return client.status.tag === "Error";
}

// Get status display info
function getStatusDisplay(client: ClientType): {
  label: string;
  color: string;
} {
  const status = client.status;

  switch (status.tag) {
    case "Connected":
      return { label: "Connected", color: "bg-emerald-500" };
    case "SendingLoginCode":
      return { label: "Sending code...", color: "bg-amber-500" };
    case "ReceivingLoginCode":
      return { label: "Enter verification code", color: "bg-blue-500" };
    case "VerifyingLoginCode":
      return { label: "Verifying code...", color: "bg-amber-500" };
    case "ReceivingPassword":
      return { label: "Enter 2FA password", color: "bg-blue-500" };
    case "VerifyingPassword":
      return { label: "Verifying password...", color: "bg-amber-500" };
    case "GeneratingQrCode":
      return { label: "Scan QR code", color: "bg-blue-500" };
    case "Error":
      return { label: `Error: ${status.value}`, color: "bg-red-500" };
    default:
      return { label: "Unknown", color: "bg-gray-500" };
  }
}

export function TelegramClientsManager(): React.ReactNode {
  const [clients] = useTable(tables.client);
  const deleteClient = useReducer(reducers.deleteClient);
  // Separate clients into connected and authenticating
  const connectedClients = clients.filter(isClientConnected);
  const authenticatingClients = clients.filter(
    (client) => isClientAuthenticating(client) || isClientError(client)
  );

  const [dialogState, setDialogState] = useState<{
    open: boolean;
    resumeClientId?: bigint;
  }>({ open: false });

  const openDialog = (): void => {
    setDialogState({ open: true });
  };

  const openDialogForResume = (clientId: bigint): void => {
    setDialogState({ open: true, resumeClientId: clientId });
  };

  const closeDialog = (open: boolean): void => {
    if (!open) {
      setDialogState({ open: false });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-2xl tracking-tight">
            Telegram Clients
          </h2>
          <p className="text-muted-foreground">
            Manage your connected Telegram accounts
          </p>
        </div>
        <Button onClick={openDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Add Client
        </Button>
      </div>

      {/* Authenticating Clients Section */}
      {authenticatingClients.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-lg text-muted-foreground">
            Pending Authentication
          </h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {authenticatingClients.map((client) => (
              <ClientCard
                client={client}
                key={client.id.toString()}
                onDelete={() => deleteClient({ clientId: client.id })}
                onResume={() => openDialogForResume(client.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Connected Clients Section */}
      {connectedClients.length > 0 && (
        <div className="space-y-3">
          {authenticatingClients.length > 0 && (
            <h3 className="font-semibold text-lg text-muted-foreground">
              Connected Clients
            </h3>
          )}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {connectedClients.map((client) => (
              <ClientCard
                client={client}
                key={client.id.toString()}
                onDelete={() => deleteClient({ clientId: client.id })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {clients.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground">No Telegram clients yet</p>
            <Button className="mt-4" onClick={openDialog} variant="outline">
              <Plus className="mr-2 h-4 w-4" />
              Add your first client
            </Button>
          </CardContent>
        </Card>
      )}

      <AddClientDialog
        onOpenChange={closeDialog}
        open={dialogState.open}
        resumeClientId={dialogState.resumeClientId}
      />
    </div>
  );
}

function getCardClassName(client: ClientType): string | undefined {
  if (isClientAuthenticating(client)) {
    return "border-amber-500/50";
  }
  if (isClientError(client)) {
    return "border-red-500/50";
  }
  return undefined;
}

function ClientCard({
  client,
  onDelete,
  onResume,
}: {
  client: ClientType;
  onDelete: () => void;
  onResume?: () => void;
}): React.ReactNode {
  const statusDisplay = getStatusDisplay(client);

  // Check if this client needs user interaction
  const needsUserAction =
    client.status.tag === "ReceivingLoginCode" ||
    client.status.tag === "ReceivingPassword";

  return (
    <Card className={getCardClassName(client)}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="font-medium text-base">
            {client.externalId || `Client #${client.id}`}
          </CardTitle>
          <CardDescription>
            {client.activeChats.length} active chat
            {client.activeChats.length !== 1 ? "s" : ""}
          </CardDescription>
        </div>
        <Button
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          size="icon"
          variant="ghost"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${statusDisplay.color}`} />
            <span className="text-muted-foreground text-sm">
              {statusDisplay.label}
            </span>
          </div>
          {needsUserAction && onResume && (
            <Button onClick={onResume} size="sm" variant="outline">
              Continue
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
