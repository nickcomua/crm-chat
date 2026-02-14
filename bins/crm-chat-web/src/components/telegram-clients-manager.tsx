import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Plus, QrCode, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type Id, onResultError } from "@/lib/convex";
import { cn } from "@/lib/utils";
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
  _id: Id<"clients">;
  kind: string;
  telegramId: string;
  externalId?: string;
  scanningChatIds: string[];
  status: ClientStatus;
}

function isClientConnected(client: ClientDoc): boolean {
  return client.status.type === "Connected";
}

function getStatusDisplay(client: ClientDoc): {
  label: string;
  dotColor: string;
  pillColor: string;
} {
  const status = client.status;

  switch (status.type) {
    case "Connected":
      return {
        label: "Connected",
        dotColor: "bg-emerald-500",
        pillColor: "bg-emerald-500/10 text-emerald-600",
      };
    case "Error":
      return {
        label: `Error: ${status.message ?? "Unknown"}`,
        dotColor: "bg-red-500",
        pillColor: "bg-red-500/10 text-red-600",
      };
    default:
      return {
        label: status.type,
        dotColor: "bg-amber-500",
        pillColor: "bg-amber-500/10 text-amber-600",
      };
  }
}

export function TelegramClientsManager(): React.ReactNode {
  const clients = useQuery(api.clients.list) as ClientDoc[] | undefined;
  const deleteClient = useMutation(api.clients.deleteClient);
  const [showAddDialog, setShowAddDialog] = useState(false);

  if (clients === undefined) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
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
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display font-semibold text-xl tracking-tight">
            Telegram Clients
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            Your connected Telegram accounts
          </p>
        </div>
        <Button
          className="h-9 text-[13px]"
          onClick={() => setShowAddDialog(true)}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add Client
        </Button>
      </div>

      {connectedClients.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {connectedClients.map((client) => (
            <ClientCard
              client={client}
              key={client._id}
              onDelete={() =>
                deleteClient({ clientId: client._id }).then(onResultError)
              }
            />
          ))}
        </div>
      )}

      {otherClients.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-display font-medium text-muted-foreground text-sm">
            Pending
          </h3>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {otherClients.map((client) => (
              <ClientCard
                client={client}
                key={client._id}
                onDelete={() =>
                  deleteClient({ clientId: client._id }).then(onResultError)
                }
              />
            ))}
          </div>
        </div>
      )}

      {clients.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-14">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
              <QrCode className="h-6 w-6 text-muted-foreground/50" />
            </div>
            <p className="mt-4 font-medium text-muted-foreground text-sm">
              No Telegram clients connected
            </p>
            <Button
              className="mt-4 h-9 text-[13px]"
              onClick={() => setShowAddDialog(true)}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Your First Client
            </Button>
          </CardContent>
        </Card>
      )}

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
  const navigate = useNavigate();
  const isConnected = isClientConnected(client);

  return (
    <Card className="group transition-shadow hover:shadow-md">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="font-medium text-sm">
            {client.telegramId || `Client ${client._id.slice(0, 8)}`}
          </CardTitle>
          <CardDescription className="text-xs">
            {client.scanningChatIds.length} active chat
            {client.scanningChatIds.length !== 1 ? "s" : ""}
          </CardDescription>
        </div>
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {isConnected && (
            <Button
              aria-label="Client settings"
              className="h-7 w-7 text-muted-foreground"
              onClick={() =>
                navigate({
                  to: "/client/$clientId",
                  params: { clientId: client._id },
                })
              }
              size="icon"
              variant="ghost"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            size="icon"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium text-xs",
            statusDisplay.pillColor
          )}
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full", statusDisplay.dotColor)}
          />
          {statusDisplay.label}
        </span>
      </CardContent>
    </Card>
  );
}
