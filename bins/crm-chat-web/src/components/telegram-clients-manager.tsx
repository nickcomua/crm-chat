import { useMutation, useQuery } from "convex/react";
import { Plus, QrCode, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/convex";
import { QrAuth } from "./client/qr-auth";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface ClientStatus {
  type: "Authenticating" | "Connected" | "Error";
  message?: string;
}

interface ClientDoc {
  _id: string;
  kind: string;
  externalId: string;
  activeChats: string[];
  status: ClientStatus;
}

function isClientConnected(client: ClientDoc): boolean {
  return client.status.type === "Connected";
}

function getStatusDisplay(client: ClientDoc): {
  label: string;
  color: string;
} {
  const status = client.status;

  switch (status.type) {
    case "Connected":
      return { label: "Connected", color: "bg-emerald-500" };
    case "Error":
      return {
        label: `Error: ${status.message ?? "Unknown"}`,
        color: "bg-red-500",
      };
    default:
      return { label: status.type, color: "bg-amber-500" };
  }
}

export function TelegramClientsManager(): React.ReactNode {
  const clients = useQuery(api.clients.list) as ClientDoc[] | undefined;
  const deleteClient = useMutation(api.clients.deleteClient);
  const [showAddDialog, setShowAddDialog] = useState(false);

  if (clients === undefined) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  const connectedClients = clients.filter(isClientConnected);
  const otherClients = clients.filter((c) => !isClientConnected(c));

  const handleAddSuccess = () => {
    setShowAddDialog(false);
  };

  const handleAddCancel = () => {
    setShowAddDialog(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-2xl tracking-tight">
            Telegram Clients
          </h2>
          <p className="text-muted-foreground">
            Your connected Telegram accounts
          </p>
        </div>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Client
        </Button>
      </div>

      {/* Connected Clients */}
      {connectedClients.length > 0 && (
        <div className="space-y-3">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {connectedClients.map((client) => (
              <ClientCard
                client={client}
                key={client._id}
                onDelete={() => deleteClient({ clientId: client._id })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Other Clients (pending, error, etc) */}
      {otherClients.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-lg text-muted-foreground">
            Pending
          </h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {otherClients.map((client) => (
              <ClientCard
                client={client}
                key={client._id}
                onDelete={() => deleteClient({ clientId: client._id })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {clients.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <QrCode className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="mb-4 text-muted-foreground">
              No Telegram clients connected
            </p>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Your First Client
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Add Client Dialog */}
      <Dialog onOpenChange={setShowAddDialog} open={showAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Telegram Client</DialogTitle>
            <DialogDescription>
              Scan this QR code with your Telegram app to connect your account.
            </DialogDescription>
          </DialogHeader>
          <QrAuth onCancel={handleAddCancel} onSuccess={handleAddSuccess} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClientCard({
  client,
  onDelete,
}: {
  client: ClientDoc;
  onDelete: () => void;
}): React.ReactNode {
  const statusDisplay = getStatusDisplay(client);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="font-medium text-base">
            {client.externalId || `Client ${client._id.slice(0, 8)}`}
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
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${statusDisplay.color}`} />
          <span className="text-muted-foreground text-sm">
            {statusDisplay.label}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
