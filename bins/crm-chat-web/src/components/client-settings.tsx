import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Pencil,
  Pin,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { api, type Id, onResultError } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaSettings {
  saveAnimations?: boolean;
  saveAudio?: boolean;
  saveDocuments?: boolean;
  savePhotos?: boolean;
  saveStickers?: boolean;
  saveVideoNotes?: boolean;
  saveVideos?: boolean;
  saveVoice?: boolean;
}

interface ChatDoc {
  _id: string;
  chatId: string;
  chatType: string;
  fullScanned?: boolean;
  isPinned: boolean;
  lastMessageTimestamp: number;
  mediaSettings?: MediaSettings;
  pinnedName?: string;
  scanEnabled?: boolean;
  scanPhase?: "ScanningMessages" | "DownloadingMedia" | "Listening";
  syncedMessages?: number;
  totalMessages?: number;
}

interface ClientDoc {
  _id: Id<"clients">;
  mediaSettings?: MediaSettings;
  phoneNumber?: string;
  status: { type: string };
  telegramId: string;
}

// ---------------------------------------------------------------------------
// Media settings config
// ---------------------------------------------------------------------------

const MEDIA_SETTINGS_ITEMS: { key: keyof MediaSettings; label: string }[] = [
  { key: "savePhotos", label: "Photos" },
  { key: "saveVideos", label: "Videos" },
  { key: "saveVideoNotes", label: "Video notes" },
  { key: "saveAudio", label: "Audio" },
  { key: "saveVoice", label: "Voice messages" },
  { key: "saveStickers", label: "Stickers" },
  { key: "saveAnimations", label: "GIFs" },
  { key: "saveDocuments", label: "Documents" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getScanStatus(chat: ChatDoc): { label: string; className: string } {
  // Active scanning phases take priority — show progress while work is happening
  if (chat.scanPhase === "ScanningMessages") {
    return {
      label: "Scanning messages...",
      className: "bg-amber-500/15 text-amber-700",
    };
  }
  // Fully scanned = "Synced" even if UpdateListener set scanPhase to "Listening"
  if (chat.fullScanned) {
    return { label: "Synced", className: "bg-emerald-500/15 text-emerald-700" };
  }
  // Not fully scanned but listening — still catching up
  if (chat.scanPhase === "Listening") {
    return {
      label: "Listening",
      className: "bg-emerald-500/15 text-emerald-700",
    };
  }
  if (chat.scanEnabled) {
    return { label: "Syncing...", className: "bg-amber-500/15 text-amber-700" };
  }
  return { label: "Not scanned", className: "bg-muted text-muted-foreground" };
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

/** Resolve the effective value for a media setting (chat → client → default false). */
function resolveMediaSetting(
  key: keyof MediaSettings,
  chatSettings?: MediaSettings,
  clientSettings?: MediaSettings
): boolean {
  const chatVal = chatSettings?.[key];
  if (chatVal !== undefined) {
    return chatVal;
  }
  const clientVal = clientSettings?.[key];
  if (clientVal !== undefined) {
    return clientVal;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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
    updatePinnedName({ chatId, pinnedName: trimmed || undefined }).then(
      onResultError
    );
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

function ProgressBar({
  label,
  percent,
}: {
  label: string;
  percent: number;
}): React.ReactNode {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {percent}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function ChatProgressBars({ chat }: { chat: ChatDoc }): React.ReactNode {
  const mediaCounts = useQuery(
    api.media.countByStatusForChat,
    chat.scanEnabled ? { chatId: chat.chatId } : "skip"
  );

  if (!chat.scanEnabled) {
    return null;
  }

  const msgTotal = chat.totalMessages ?? 0;
  const msgSynced = chat.syncedMessages ?? 0;
  const msgPercent =
    msgTotal > 0 ? Math.min(100, Math.round((msgSynced / msgTotal) * 100)) : 0;

  const mediaTotal = mediaCounts ? mediaCounts.total - mediaCounts.Skipped : 0;
  const mediaStored = mediaCounts?.Stored ?? 0;
  const mediaPercent =
    mediaTotal > 0
      ? Math.min(100, Math.round((mediaStored / mediaTotal) * 100))
      : 0;

  return (
    <div className="mt-2 space-y-1.5">
      {chat.scanPhase === "ScanningMessages" && msgTotal > 0 && (
        <ProgressBar
          label={`${msgSynced} / ${msgTotal} messages`}
          percent={msgPercent}
        />
      )}
      {mediaCounts && mediaTotal > 0 && mediaPercent < 100 && (
        <ProgressBar
          label={`${mediaStored} / ${mediaTotal} media`}
          percent={mediaPercent}
        />
      )}
      {chat.scanPhase === "Listening" && (
        <div className="flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          <span className="text-[11px] text-muted-foreground">
            Listening for updates
          </span>
        </div>
      )}
    </div>
  );
}

function MediaSettingsPanel({
  chat,
  clientSettings,
}: {
  chat: ChatDoc;
  clientSettings?: MediaSettings;
}): React.ReactNode {
  const updateMediaSettings = useMutation(api.chats.updateMediaSettings);

  const handleToggle = (key: keyof MediaSettings, checked: boolean): void => {
    const current = chat.mediaSettings ?? {};
    updateMediaSettings({
      chatId: chat.chatId,
      mediaSettings: { ...current, [key]: checked },
    }).then(onResultError);
  };

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-2 pb-1">
      {MEDIA_SETTINGS_ITEMS.map(({ key, label }) => {
        const effective = resolveMediaSetting(
          key,
          chat.mediaSettings,
          clientSettings
        );
        const isInherited = chat.mediaSettings?.[key] === undefined;
        return (
          <div className="flex items-center justify-between gap-2" key={key}>
            <span
              className={cn(
                "text-[12px]",
                isInherited ? "text-muted-foreground/70" : "text-foreground"
              )}
            >
              {label}
              {isInherited && (
                <span className="ml-1 text-[10px] text-muted-foreground/50">
                  (default)
                </span>
              )}
            </span>
            <Switch
              aria-label={`Download ${label}`}
              checked={effective}
              className="scale-75"
              onCheckedChange={(checked) => handleToggle(key, checked)}
            />
          </div>
        );
      })}
    </div>
  );
}

function ChatRow({
  chat,
  clientSettings,
}: {
  chat: ChatDoc;
  clientSettings?: MediaSettings;
}): React.ReactNode {
  const updateScanEnabled = useMutation(api.chats.updateScanEnabled);
  const rescan = useMutation(api.chats.rescan);
  const [expanded, setExpanded] = useState(false);
  const scanStatus = getScanStatus(chat);
  const displayName = getChatDisplayName(chat);

  return (
    <div className="px-6 py-3">
      <div className="flex items-center gap-3">
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
            <EditableName chatId={chat.chatId} currentName={displayName} />
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
            {chat.scanEnabled && chat.fullScanned && (
              <button
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() =>
                  rescan({ chatId: chat.chatId }).then(onResultError)
                }
                title="Re-scan all messages"
                type="button"
              >
                <RefreshCw className="h-3 w-3" />
                Rescan
              </button>
            )}
          </div>
          <ChatProgressBars chat={chat} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {chat.scanEnabled && (
            <button
              aria-label="Toggle media settings"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
              type="button"
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          )}
          <Switch
            aria-label={`Toggle scanning for ${displayName}`}
            checked={chat.scanEnabled ?? false}
            onCheckedChange={(checked) =>
              updateScanEnabled({
                chatId: chat.chatId,
                scanEnabled: checked,
              }).then(onResultError)
            }
          />
        </div>
      </div>

      {expanded && chat.scanEnabled && (
        <div className="mt-2 ml-12 rounded-lg border border-border/50 px-4 py-2">
          <p className="mb-1 font-medium text-[12px] text-muted-foreground">
            Auto-download media types
          </p>
          <MediaSettingsPanel chat={chat} clientSettings={clientSettings} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ClientSettings({
  clientId,
}: {
  clientId: Id<"clients">;
}): React.ReactNode {
  const chats = useQuery(api.chats.listByClient, { clientId });
  const clients = useQuery(api.clients.list);
  const navigate = useNavigate();
  const triggerSync = useMutation(api.clients.triggerDialogSync);

  if (chats === undefined || clients === undefined) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  const client = clients.find((c: { _id: string }) => c._id === clientId) as
    | ClientDoc
    | undefined;

  if (!client) {
    return (
      <div className="container px-4 py-8">
        <p className="text-muted-foreground">Client not found</p>
      </div>
    );
  }

  const isConnected = client.status.type === "Connected";

  const sortedChats = [...chats].sort((a, b) => {
    if (a.isPinned && !b.isPinned) {
      return -1;
    }
    if (!a.isPinned && b.isPinned) {
      return 1;
    }
    return b.lastMessageTimestamp - a.lastMessageTimestamp;
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
        <div className="flex-1">
          <h2 className="font-bold text-2xl tracking-tight">
            {client.telegramId || `Client ${client._id.slice(0, 8)}`}
          </h2>
          <p className="text-muted-foreground text-sm">
            {chats.length} chat{chats.length !== 1 ? "s" : ""} &middot;{" "}
            {chats.filter((c) => c.scanEnabled).length} scan-enabled
          </p>
        </div>
        {isConnected && (
          <Button
            onClick={() =>
              triggerSync({ clientId: client._id }).then(onResultError)
            }
            size="sm"
            variant="outline"
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Sync Dialogs
          </Button>
        )}
      </div>

      {sortedChats.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <MessageSquare className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">
              No chats synced yet. Click &ldquo;Sync Dialogs&rdquo; to fetch
              your conversations.
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
              {sortedChats.map((chat) => (
                <ChatRow
                  chat={chat}
                  clientSettings={client.mediaSettings}
                  key={chat._id}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
