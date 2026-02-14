import { useQuery } from "convex/react";
import { Filter, MessageSquare, Pin, Search, Users } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/convex";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface Client {
  _id: string;
  kind: string;
  externalId: string;
}

interface ChatListProps {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
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

function getClientDisplayName(client: {
  kind: string;
  externalId: string;
}): string {
  return `${client.kind} (${client.externalId.slice(0, 8)}...)`;
}

const WHITESPACE_RE = /\s+/;

function getInitials(name: string): string {
  const parts = name.trim().split(WHITESPACE_RE);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getAvatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: intentional hash
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const hue2 = (hue + 45) % 360;
  return `linear-gradient(135deg, oklch(0.68 0.16 ${hue}), oklch(0.55 0.18 ${hue2}))`;
}

function getExternalIdColorStyle(externalId: string): {
  background: string;
  color: string;
} {
  let hash = 0;
  for (let i = 0; i < externalId.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: intentional hash
    hash = externalId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return {
    background: `oklch(0.65 0.18 ${hue} / 0.15)`,
    color: `oklch(0.5 0.18 ${hue})`,
  };
}

export function ChatList({
  selectedChatId,
  onSelectChat,
}: ChatListProps): React.ReactNode {
  const chats = useQuery(api.chats.list);
  const clients = useQuery(api.clients.list) as Client[] | undefined;
  const chatIds = chats?.map((c: { chatId: string }) => c.chatId);
  const lastMessages = useQuery(
    api.messages.getLastPerChat,
    chatIds ? { chatIds } : "skip"
  ) as Array<{ chatId: string; text?: string; mediaId?: string }> | undefined;
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [showClientFilter, setShowClientFilter] = useState(false);

  if (
    chats === undefined ||
    clients === undefined ||
    lastMessages === undefined
  ) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  const clientsArray = Array.from(clients);

  const clientsMap = new Map<string, (typeof clients)[number]>();
  for (const client of clientsArray) {
    clientsMap.set(client._id, client);
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

  let filteredChats = sortedChats;

  if (selectedClientId !== null) {
    filteredChats = filteredChats.filter(
      (chat) => chat.clientId === selectedClientId
    );
  }

  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    filteredChats = filteredChats.filter((chat) => {
      const name = getChatDisplayName(chat).toLowerCase();
      return name.includes(query);
    });
  }

  const lastMessagesMap = new Map(lastMessages.map((m) => [m.chatId, m]));

  const getLastMessage = (chatId: string): string | null => {
    const entry = lastMessagesMap.get(chatId);
    if (!entry) {
      return null;
    }
    return entry.text ?? (entry.mediaId ? "[Media]" : null);
  };

  if (chats.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <MessageSquare className="h-6 w-6 text-primary/50" />
        </div>
        <p className="mt-4 font-display font-medium text-muted-foreground text-sm">
          No chats yet
        </p>
        <p className="mt-1 text-muted-foreground/60 text-xs">
          Connect a Telegram client to see your chats
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="space-y-2 p-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search chats"
              className="h-8 border-transparent bg-muted/60 pl-8 text-[13px] placeholder:text-muted-foreground/50 focus:border-border focus:bg-background"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats..."
              type="search"
              value={searchQuery}
            />
          </div>
          {clientsArray.length > 1 && (
            <Button
              aria-label="Filter clients"
              className={cn(
                "h-8 w-8",
                selectedClientId !== null && "bg-accent text-accent-foreground"
              )}
              onClick={() => setShowClientFilter(!showClientFilter)}
              size="icon"
              variant="outline"
            >
              <Filter className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {showClientFilter && clientsArray.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              className={cn(
                "rounded-md px-2 py-0.5 text-xs transition-colors",
                selectedClientId === null
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
              onClick={() => setSelectedClientId(null)}
              type="button"
            >
              All
            </button>
            {clientsArray.map((client) => (
              <button
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs transition-colors",
                  selectedClientId === client._id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
                key={client._id}
                onClick={() => setSelectedClientId(client._id)}
                type="button"
              >
                {getClientDisplayName(client)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {filteredChats.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-xs">
            No chats found
          </div>
        ) : (
          <div className="space-y-px">
            {filteredChats.map((chat) => {
              const lastMessage = getLastMessage(chat.chatId);
              const isSelected = selectedChatId === chat.chatId;
              const client = clientsMap.get(chat.clientId);
              const displayName = getChatDisplayName(chat);

              return (
                <button
                  className={cn(
                    "group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all",
                    isSelected ? "bg-accent/80" : "hover:bg-muted/40"
                  )}
                  key={chat._id}
                  onClick={() => onSelectChat(chat.chatId)}
                  type="button"
                >
                  {isSelected && (
                    <div className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                  )}

                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-medium text-white text-xs shadow-sm"
                    style={{ background: getAvatarGradient(displayName) }}
                  >
                    {chat.chatType === "Group" ? (
                      <Users className="h-4 w-4" />
                    ) : (
                      getInitials(displayName)
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1">
                        {client?.kind === "Telegram" && (
                          <i className="nf nf-fae-telegram shrink-0 text-blue-500 text-xs" />
                        )}
                        <span className="truncate font-medium text-[13px]">
                          {displayName}
                        </span>
                        {chat.isPinned && (
                          <Pin className="h-2.5 w-2.5 shrink-0 text-muted-foreground/60" />
                        )}
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground/70">
                        {formatTimestamp(chat.lastMessageTs)}
                      </span>
                    </div>

                    <div className="mt-px flex items-center gap-1.5">
                      {client && (
                        <span
                          className="shrink-0 rounded px-1.5 py-px font-medium text-[10px]"
                          style={getExternalIdColorStyle(client.externalId)}
                        >
                          {client.externalId}
                        </span>
                      )}
                      {lastMessage && (
                        <p className="min-w-0 flex-1 truncate text-muted-foreground/70 text-xs">
                          {lastMessage}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
