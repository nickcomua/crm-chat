import { useQuery } from "convex/react";
import { Filter, MessageSquare, Pin, Search, Users } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/convex";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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

function getExternalIdColorStyle(externalId: string): {
  background: string;
  color: string;
} {
  // Simple hash function to get a consistent hue for each external ID
  let hash = 0;
  for (let i = 0; i < externalId.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: intentional hash function
    hash = externalId.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Map hash to hue (0-360)
  const hue = Math.abs(hash) % 360;

  // Use consistent lightness and chroma values for uniform appearance
  return {
    background: `oklch(0.65 0.18 ${hue} / 0.2)`,
    color: `oklch(0.45 0.2 ${hue})`,
  };
}

function ChatIcon({ chatType }: { chatType: string }): React.ReactNode {
  if (chatType === "Group") {
    return <Users className="h-5 w-5" />;
  }
  return <MessageSquare className="h-5 w-5" />;
}

export function ChatList({
  selectedChatId,
  onSelectChat,
}: ChatListProps): React.ReactNode {
  const chats = useQuery(api.chats.list);
  const clients = useQuery(api.clients.list);
  const messages = useQuery(api.messages.list);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [showClientFilter, setShowClientFilter] = useState(false);

  if (chats === undefined || clients === undefined || messages === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
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

  const getLastMessage = (chatId: string): string | null => {
    const chatMessages = messages.filter(
      (m) => m.chatId === chatId && !m.deleted
    );
    if (chatMessages.length === 0) {
      return null;
    }

    const lastMessage = chatMessages.reduce((prev, curr) =>
      curr.ts > prev.ts ? curr : prev
    );
    return lastMessage.text ?? "[Media]";
  };

  if (chats.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <MessageSquare className="h-7 w-7 text-primary/50" />
        </div>
        <p className="mt-4 font-display font-medium text-muted-foreground">
          No chats yet
        </p>
        <p className="mt-1 text-muted-foreground/70 text-sm">
          Connect a Telegram client to see your chats
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search chats"
              className="pl-9"
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
                selectedClientId !== null && "bg-accent text-accent-foreground"
              )}
              onClick={() => setShowClientFilter(!showClientFilter)}
              size="icon"
              variant="outline"
            >
              <Filter className="h-4 w-4" />
            </Button>
          )}
        </div>

        {showClientFilter && clientsArray.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              className={cn(
                "rounded-full px-2.5 py-1 text-xs transition-colors",
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
                  "rounded-full px-2.5 py-1 text-xs transition-colors",
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

      <div className="flex-1 overflow-y-auto">
        {filteredChats.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            No chats found
          </div>
        ) : (
          <div className="space-y-0.5 px-2">
            {filteredChats.map((chat) => {
              const lastMessage = getLastMessage(chat.chatId);
              const isSelected = selectedChatId === chat.chatId;
              const client = clientsMap.get(chat.clientId);

              return (
                <button
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/50"
                  )}
                  key={chat._id}
                  onClick={() => onSelectChat(chat.chatId)}
                  type="button"
                >
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                      isSelected
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    <ChatIcon chatType={chat.chatType} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {client?.kind === "Telegram" && (
                          <i className="nf nf-fae-telegram shrink-0 text-blue-500" />
                        )}
                        <span className="truncate font-medium">
                          {getChatDisplayName(chat)}
                        </span>
                        {chat.isPinned && (
                          <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {formatTimestamp(chat.lastMessageTs)}
                      </span>
                    </div>

                    <div className="mt-0.5 flex items-center gap-2">
                      {client && (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 font-medium text-xs"
                          style={getExternalIdColorStyle(client.externalId)}
                        >
                          {client.externalId}
                        </span>
                      )}
                      {lastMessage && (
                        <p className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
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
