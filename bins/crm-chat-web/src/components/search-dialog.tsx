import { Loader2, Search, Sparkles, X } from "lucide-react";
import { useState } from "react";
import type { Infer } from "spacetimedb";
import { useTable } from "spacetimedb/react";
import {
  type MessageSource,
  type SearchHit,
  useSearchAll,
  useSearchInChat,
  useSearchInClient,
} from "@/hooks/use-search";
import { type Chat, type Client, tables } from "@/lib/spacetime";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

type ChatType = Infer<typeof Chat>;
type ClientType = Infer<typeof Client>;

type SearchScopeType =
  | { type: "all" }
  | { type: "chat"; chatId: string }
  | { type: "client"; clientId: number };

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectResult?: (result: { chatId: string; messageId?: string }) => void;
  initialScope?: SearchScopeType;
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
  chatsMap,
  clientsMap,
  onClick,
}: {
  hit: SearchHit;
  chatsMap: Map<string, ChatType>;
  clientsMap: Map<bigint, ClientType>;
  onClick: () => void;
}): React.ReactNode {
  const source = hit._source as unknown as MessageSource | undefined;
  if (!source) {
    return null;
  }

  const chat = source.chat_id ? chatsMap.get(source.chat_id) : undefined;
  const client =
    source.client_id !== undefined && source.client_id !== null
      ? clientsMap.get(BigInt(source.client_id))
      : undefined;

  const chatName =
    chat?.pinnedName ?? `Chat ${source.chat_id?.slice(0, 8) ?? "unknown"}`;
  const isOutgoing = source.out ?? false;

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
                {client.kind.tag}
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
            {source.content ?? "[Media]"}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {source.created_at && (
            <span className="text-muted-foreground text-xs">
              {formatTimestamp(source.created_at)}
            </span>
          )}
          {hit._score && (
            <div className="mt-0.5 text-muted-foreground/60 text-xs">
              {hit._score.toFixed(2)}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function useActiveSearch(
  query: string,
  scope: SearchScopeType,
  semantic: boolean
) {
  const allSearch = useSearchAll(query, {
    semantic,
    enabled: scope.type === "all" && query.length > 0,
  });

  const chatSearch = useSearchInChat(
    scope.type === "chat" ? scope.chatId : "",
    query,
    {
      semantic,
      enabled: scope.type === "chat" && query.length > 0,
    }
  );

  const clientSearch = useSearchInClient(
    scope.type === "client" ? scope.clientId : 0,
    query,
    {
      semantic,
      enabled: scope.type === "client" && query.length > 0,
    }
  );

  if (scope.type === "all") {
    return allSearch;
  }
  if (scope.type === "chat") {
    return chatSearch;
  }
  return clientSearch;
}

function SearchResults({
  query,
  scope,
  semantic,
  chatsMap,
  clientsMap,
  onSelectResult,
}: {
  query: string;
  scope: SearchScopeType;
  semantic: boolean;
  chatsMap: Map<string, ChatType>;
  clientsMap: Map<bigint, ClientType>;
  onSelectResult?: (result: { chatId: string; messageId?: string }) => void;
}): React.ReactNode {
  const search = useActiveSearch(query, scope, semantic);

  if (query.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
        Enter a search term to find messages
      </div>
    );
  }

  if (search.isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (search.isError) {
    return (
      <div className="flex h-48 items-center justify-center text-destructive text-sm">
        Search failed: {search.error?.message ?? "Unknown error"}
      </div>
    );
  }

  const hits = search.data?.hits.hits ?? [];
  const totalObj = search.data?.hits.total as
    | { value: number; relation: string }
    | undefined;
  const total = totalObj?.value ?? 0;

  if (hits.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
        No results found for "{query}"
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="px-3 py-2 text-muted-foreground text-xs">
        {total} result{total !== 1 ? "s" : ""} found
        {search.isFetching && (
          <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />
        )}
      </div>
      <div className="max-h-96 space-y-1 overflow-y-auto">
        {hits.map((hit) => (
          <SearchResultItem
            chatsMap={chatsMap}
            clientsMap={clientsMap}
            hit={hit}
            key={hit._id}
            onClick={() => {
              const source = hit._source as unknown as
                | MessageSource
                | undefined;
              if (source?.chat_id && onSelectResult) {
                onSelectResult({
                  chatId: source.chat_id,
                  messageId: source.id,
                });
              }
            }}
          />
        ))}
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
  const [scope, setScope] = useState<SearchScopeType>(initialScope);
  const [semantic, setSemantic] = useState(false);

  const [chats] = useTable(tables.chat);
  const [clients] = useTable(tables.client);

  const chatsMap = new Map<string, ChatType>();
  for (const chat of chats) {
    chatsMap.set(chat.id, chat);
  }

  const clientsMap = new Map<bigint, ClientType>();
  for (const client of clients) {
    clientsMap.set(client.id, client);
  }

  const clientsArray = Array.from(clients);

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
              aria-label={
                semantic ? "Semantic search enabled" : "Enable semantic search"
              }
              aria-pressed={semantic}
              className={cn(semantic && "bg-primary text-primary-foreground")}
              onClick={() => setSemantic(!semantic)}
              size="icon"
              title={
                semantic ? "Using semantic search" : "Using keyword search"
              }
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
            {clientsArray.map((client) => (
              <button
                className={cn(
                  "rounded-full px-3 py-1 text-sm transition-colors",
                  scope.type === "client" &&
                    scope.clientId === Number(client.id)
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
                key={String(client.id)}
                onClick={() =>
                  setScope({ type: "client", clientId: Number(client.id) })
                }
                type="button"
              >
                {client.kind.tag} ({client.externalId.slice(0, 8)}...)
              </button>
            ))}
          </div>

          <SearchResults
            chatsMap={chatsMap}
            clientsMap={clientsMap}
            onSelectResult={handleSelectResult}
            query={query}
            scope={scope}
            semantic={semantic}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
