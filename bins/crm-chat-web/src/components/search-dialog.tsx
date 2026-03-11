import { useQuery } from "convex-helpers/react/cache";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { api, type Doc } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { usePaginatedQuery } from "convex/react";
import type { TextByKeywordsParameters } from "../../../convex-backend/convex/search";

interface SearchDialogProps {
  initialScope?: TextByKeywordsParameters["scope"];
  onOpenChange: (open: boolean) => void;
  onSelectResult?: (result: { chatId: string; messageId?: string }) => void;
  open: boolean;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SearchResultItem({
  hit,
  chat,
  client,
  onClick,
}: {
  hit: Doc<"messages">;
  chat: Doc<"chats"> | undefined;
  client: Doc<"clients"> | undefined;
  onClick: () => void;
}): React.ReactNode {
  const chatName = chat?.pinnedName ?? `Chat ${hit.chatId?.slice(0, 8) ?? "unknown"}`;
  const isOutgoing = hit.outgoing ?? false;

  return (
    <button
      className="w-full rounded-lg p-3 text-left transition-colors hover:bg-muted/50"
      onClick={onClick}
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">{chatName}</span>
            {client && (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
                {client.kind}
              </span>
            )}
          </div>
          <p
            className={cn(
              "mt-1 line-clamp-2 text-sm",
              isOutgoing ? "text-muted-foreground" : ""
            )}
          >
            {isOutgoing && <span className="text-primary">You: </span>}
            {hit.text ?? "[Media]"}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {hit.timestamp && (
            <span className="text-muted-foreground text-xs">
              {formatTimestamp(hit.timestamp)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function SearchResults({
  query,
  scope,
  chatsMap,
  clientsMap,
  onSelectResult,
}: {
  query: string;
  scope: TextByKeywordsParameters["scope"];
  chatsMap: Map<string, Doc<"chats">>;
  clientsMap: Map<string, Doc<"clients">>;
  onSelectResult?: (result: { chatId: string; messageId?: string }) => void;
}): React.ReactNode {
  const { results, status, loadMore } = usePaginatedQuery(
    api.search.textByKeywords,
    { keywords: query, scope },
    { initialNumItems: 32 }
  );

  if (query.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
        Enter keywords to search for in messages
      </div>
    );
  }

  if (status === "LoadingFirstPage") {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
        No results found
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="px-3 py-2 text-muted-foreground text-xs">
        {results.length} result{results.length !== 1 ? "s" : ""} found
      </div>
      <div className="max-h-96 space-y-1 overflow-y-auto">
        {results.map((hit) => {
          const chat = hit.chatId ? chatsMap.get(hit.chatId) : undefined;
          const client = hit.clientId ? clientsMap.get(String(hit.clientId)) : undefined;
          return (
            <SearchResultItem
              chat={chat}
              client={client}
              hit={hit}
              key={hit._id}
              onClick={() => {
                if (hit.chatId && onSelectResult) {
                  onSelectResult({
                    chatId: hit.chatId,
                    messageId: hit.messageId,
                  });
                }
              }}
            />
          );
        })}

        <div className="flex items-center justify-center py-2">
          {(() => {
            switch (status) {
              case "LoadingMore":
                return (<Loader2 className="h-4 w-4 animate-spin" />)
              case "CanLoadMore":
                return (<Button
                  onClick={() => loadMore(32)}
                  variant="outline"
                  size="sm"
                >
                  Load more
                </Button>)
              case "Exhausted":
                return (<p className="text-sm text-muted-foreground">Shown all results</p>)
            }
          })()}
        </div>
      </div>
    </div>
  );
}

export function SearchDialog({
  open,
  onOpenChange,
  onSelectResult,
  initialScope = { type: "all" },
}: SearchDialogProps): React.ReactNode {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TextByKeywordsParameters["scope"]>(initialScope);
  const [semantic, setSemantic] = useState(false);

  const chats = useQuery(api.chats.list);
  const clients = useQuery(api.clients.list);

  const chatsMap = new Map<string, Doc<"chats">>();
  for (const chat of chats ?? []) {
    chatsMap.set(chat.chatId, chat);
  }

  const clientsMap = new Map<string, Doc<"clients">>();
  for (const client of clients ?? []) {
    clientsMap.set(client._id, client);
  }

  const clientsArray = clients ?? [];

  const handleSelectResult = (result: {
    chatId: string;
    messageId?: string;
  }) => {
    onSelectResult?.(result);
    onOpenChange(false);
    setQuery("");
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Search Messages</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                className="pr-9 pl-9"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages..."
                type="search"
                value={query}
              />
              {query && (
                <button
                  aria-label="Clear search"
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setQuery("")}
                  type="button"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              disabled
              aria-label={
                semantic ? "Semantic search enabled" : "Enable semantic search"
              }
              aria-pressed={semantic}
              className={cn(semantic && "bg-primary text-primary-foreground")}
              onClick={() => setSemantic(!semantic)}
              size="icon"
              title="Semantic search is not yet available"
              variant={semantic ? "default" : "outline"}
            >
              <Sparkles className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className={cn(
                "rounded-full px-3 py-1 text-sm transition-colors",
                scope.type === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
              onClick={() => setScope({ type: "all" })}
              type="button"
            >
              All messages
            </button>
            {clientsArray.map((client: Doc<"clients">) => (
              <button
                className={cn(
                  "rounded-full px-3 py-1 text-sm transition-colors",
                  scope.type === "client" &&
                    scope.clientId === client._id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
                key={client._id}
                onClick={() =>
                  setScope({ type: "client", clientId: client._id })
                }
                type="button"
              >
                {client.kind} ({client.telegramId.slice(0, 8)}...)
              </button>
            ))}
          </div>

          <SearchResults
            chatsMap={chatsMap}
            clientsMap={clientsMap}
            onSelectResult={handleSelectResult}
            query={query}
            scope={scope}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
