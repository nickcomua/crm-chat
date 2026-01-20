import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Infer } from "spacetimedb";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { type Client, type DbConnection, tables } from "../lib/spacetime";
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

// Helper to check if a client needs user input or is in QR login flow
function clientNeedsUserInput(client: ClientType): boolean {
  const status = client.status;
  // Client needs input when:
  // - WaitingCode or WaitingPassword without a value (needs user to enter code/password)
  // - WaitingQrCode (needs user to scan QR code or wait for URL)
  return (
    ((status.tag === "WaitingCode" || status.tag === "WaitingPassword") &&
      status.value === undefined) ||
    status.tag === "WaitingQrCode"
  );
}

// Helper to check if a client is pending (not connected)
function isClientPending(client: ClientType): boolean {
  return !isClientConnected(client);
}

// Get status display info
function getStatusDisplay(client: ClientType): {
  label: string;
  color: string;
} {
  const status = client.status;

  if (status.tag === "Connected") {
    return { label: "Connected", color: "bg-emerald-500" };
  }
  if (status.tag === "WaitingPhone") {
    if (status.value !== undefined) {
      return { label: "Sending code...", color: "bg-amber-500" };
    }
    return { label: "Enter phone", color: "bg-amber-500" };
  }
  if (status.tag === "WaitingCode") {
    if (status.value !== undefined) {
      return { label: "Verifying code...", color: "bg-amber-500" };
    }
    return { label: "Enter code", color: "bg-amber-500" };
  }
  if (status.tag === "WaitingPassword") {
    if (status.value !== undefined) {
      return { label: "Verifying password...", color: "bg-amber-500" };
    }
    return { label: "Enter password", color: "bg-amber-500" };
  }
  if (status.tag === "WaitingQrCode") {
    if (status.value !== undefined) {
      return { label: "Scan QR code", color: "bg-blue-500" };
    }
    return { label: "Generating QR...", color: "bg-amber-500" };
  }

  return { label: "Unknown", color: "bg-gray-500" };
}

export function TelegramClientsManager() {
  const { getConnection, isActive } = useSpacetimeDB();
  const conn = getConnection<DbConnection>();
  const [clients] = useTable(tables.client);
  const [users] = useTable(tables.user);
  console.log(users, clients);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedPendingClientId, setSelectedPendingClientId] = useState<
    bigint | null
  >(null);

  // Separate clients into connected and pending
  const { connectedClients, pendingClients } = (() => {
    const connected: ClientType[] = [];
    const pending: ClientType[] = [];

    for (const client of clients) {
      if (isClientConnected(client)) {
        connected.push(client);
      } else {
        pending.push(client);
      }
    }

    return { connectedClients: connected, pendingClients: pending };
  })();

  // Find the pending client that needs user input or the selected one
  const activePendingClient = (() => {
    // First check if we have a selected pending client
    if (selectedPendingClientId) {
      const selected = pendingClients.find(
        (c) => c.id === selectedPendingClientId
      );
      if (selected) {
        return selected;
      }
    }

    // Otherwise find any client that needs user input
    return pendingClients.find(clientNeedsUserInput) ?? null;
  })();

  // Auto-open dialog when a pending client needs user input
  useEffect(() => {
    if (activePendingClient && clientNeedsUserInput(activePendingClient)) {
      const timer = setTimeout(() => {
        setIsAddDialogOpen(true);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [activePendingClient]);

  const handleDeleteClient = (clientId: bigint) => {
    if (!conn) {
      return;
    }
    conn.reducers.deleteClient({ clientId });
  };

  const handleOpenAddDialog = () => {
    setSelectedPendingClientId(null);
    setIsAddDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setIsAddDialogOpen(open);
    if (!open) {
      setSelectedPendingClientId(null);
    }
  };

  const handleContinuePendingClient = (client: ClientType) => {
    setSelectedPendingClientId(client.id);
    setIsAddDialogOpen(true);
  };

  if (!isActive) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          Connecting to SpacetimeDB...
        </span>
      </div>
    );
  }

  const hasNoClients =
    connectedClients.length === 0 && pendingClients.length === 0;

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
        <Button onClick={handleOpenAddDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Add Client
        </Button>
      </div>

      {/* Pending Clients Section */}
      {pendingClients.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-lg text-muted-foreground">
            Pending Authentication
          </h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {pendingClients.map((client) => (
              <ClientCard
                client={client}
                key={client.id.toString()}
                onContinue={() => handleContinuePendingClient(client)}
                onDelete={() => handleDeleteClient(client.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Connected Clients Section */}
      {connectedClients.length > 0 && (
        <div className="space-y-3">
          {pendingClients.length > 0 && (
            <h3 className="font-semibold text-lg text-muted-foreground">
              Connected Clients
            </h3>
          )}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {connectedClients.map((client) => (
              <ClientCard
                client={client}
                key={client.id.toString()}
                onDelete={() => handleDeleteClient(client.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {hasNoClients && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground">No Telegram clients yet</p>
            <Button
              className="mt-4"
              onClick={handleOpenAddDialog}
              variant="outline"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add your first client
            </Button>
          </CardContent>
        </Card>
      )}

      <AddClientDialog
        connection={conn}
        onOpenChange={handleDialogOpenChange}
        open={isAddDialogOpen}
        pendingClient={activePendingClient}
      />
    </div>
  );
}

function ClientCard({
  client,
  onDelete,
  onContinue,
}: {
  client: ClientType;
  onDelete: () => void;
  onContinue?: () => void;
}) {
  const statusDisplay = getStatusDisplay(client);
  const isPending = isClientPending(client);
  const needsInput = clientNeedsUserInput(client);

  return (
    <Card className={isPending ? "border-amber-500/50" : undefined}>
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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${statusDisplay.color}`} />
            <span className="text-muted-foreground text-sm">
              {statusDisplay.label}
            </span>
          </div>
          {isPending && needsInput && onContinue && (
            <Button onClick={onContinue} size="sm" variant="outline">
              Continue
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
