import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Check,
  MessageSquare,
  Pencil,
  Pin,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

interface ChatDoc {
  _id: string;
  chatId: string;
  chatType: string;
  isPinned: boolean;
  pinnedName?: string;
  lastMessageTs: number;
  scanEnabled?: boolean;
  fullScanned?: boolean;
}

function getScanStatus(chat: ChatDoc): { label: string; className: string } {
  if (chat.fullScanned) {
    return { label: "Synced", className: "bg-emerald-500/15 text-emerald-700" };
  }
  if (chat.scanEnabled) {
    return {
      label: "Syncing...",
      className: "bg-amber-500/15 text-amber-700",
    };
  }
  return {
    label: "Not scanned",
    className: "bg-muted text-muted-foreground",
  };
}

function getChatDisplayName(chat: {
  pinnedName?: string;
  chatId: string;
}): string {
  if (chat.pinnedName) {
    return chat.pinnedName;
  }
  return `Chat ${chat.chatId.slice(0, 8)}`;
}

function EditableName({
  chatId,
  currentName,
}: {
  chatId: string;
  currentName: string;
}): React.ReactNode {
  const updatePinnedName = useMutation(api.chats.updatePinnedName);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentName);

  const handleSave = (): void => {
    const trimmed = value.trim();
    updatePinnedName({
      chatId,
      pinnedName: trimmed || undefined,
    });
    setEditing(false);
  };

  const handleCancel = (): void => {
    setValue(currentName);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          className="h-7 text-sm"
          onBlur={handleSave}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Custom name..."
          value={value}
        />
        <Button
          aria-label="Save name"
          onClick={handleSave}
          size="icon"
          variant="ghost"
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button
          aria-label="Cancel editing"
          onMouseDown={(e) => {
            e.preventDefault();
            handleCancel();
          }}
          size="icon"
          variant="ghost"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <button
      className="group flex items-center gap-1.5 text-left"
      onClick={() => {
        setValue(currentName);
        setEditing(true);
      }}
      type="button"
    >
      <span className="font-medium">{currentName}</span>
      <Pencil className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

export function ClientSettings({
  clientId,
}: {
  clientId: string;
}): React.ReactNode {
  const chats = useQuery(api.chats.listByClient, { clientId }) as
    | ChatDoc[]
    | undefined;
  const clients = useQuery(api.clients.list);
  const updateScanEnabled = useMutation(api.chats.updateScanEnabled);
  const navigate = useNavigate();

  if (chats === undefined || clients === undefined) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  const client = clients.find((c: { _id: string }) => c._id === clientId);

  if (!client) {
    return (
      <div className="container px-4 py-8">
        <p className="text-muted-foreground">Client not found</p>
      </div>
    );
  }

  const sortedChats = [...chats].sort((a, b) => {
    if (a.isPinned && !b.isPinned) {
      return -1;
    }
    if (!a.isPinned && b.isPinned) {
      return 1;
    }
    return b.lastMessageTs - a.lastMessageTs;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          aria-label="Back to settings"
          onClick={() => navigate({ to: "/settings" })}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="font-bold text-2xl tracking-tight">
            {client.externalId || `Client ${client._id.slice(0, 8)}`}
          </h2>
          <p className="text-muted-foreground text-sm">
            {chats.length} chat{chats.length !== 1 ? "s" : ""} &middot;{" "}
            {chats.filter((c) => c.scanEnabled).length} scan-enabled
          </p>
        </div>
      </div>

      {sortedChats.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <MessageSquare className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">
              No chats synced yet. The subscriber will sync dialogs
              automatically.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Chat Scanning</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {sortedChats.map((chat) => {
                const scanStatus = getScanStatus(chat);
                const displayName = getChatDisplayName(chat);

                return (
                  <div
                    className="flex items-center gap-3 px-6 py-3"
                    key={chat._id}
                  >
                    <div
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                        "bg-muted text-muted-foreground"
                      )}
                    >
                      {chat.chatType === "Group" ? (
                        <Users className="h-4 w-4" />
                      ) : (
                        <MessageSquare className="h-4 w-4" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <EditableName
                          chatId={chat.chatId}
                          currentName={displayName}
                        />
                        {chat.isPinned && (
                          <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            scanStatus.className
                          )}
                        >
                          {scanStatus.label}
                        </span>
                      </div>
                    </div>

                    <Switch
                      aria-label={`Toggle scanning for ${displayName}`}
                      checked={chat.scanEnabled ?? false}
                      onCheckedChange={(checked) =>
                        updateScanEnabled({
                          chatId: chat.chatId,
                          scanEnabled: checked,
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
