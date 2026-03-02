import { useQuery } from "convex-helpers/react/cache";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { useState } from "react";
import {
  type MessageSource,
  type SearchHit,
  useSearchAll,
  useSearchInChat,
  useSearchInClient,
} from "@/hooks/use-search";
import { api, type Id } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { usePaginatedQuery } from "convex/react";

interface ChatDoc {
  _id: string;
  chatId: string;
  clientId: string;
  pinnedName?: string;
}

interface ClientDoc {
  _id: string;
  kind: string;
  telegramId: string;
}

type SearchScopeType =
  | { type: "all" }
  | { type: "chat"; chatId: Id<"chats"> }
  | { type: "client"; clientId: Id<"clients"> };

interface SearchDialogProps {
  initialScope?: SearchScopeType;
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
  chatsMap,
  clientsMap,
  onClick,
}: {
  hit: SearchHit;
  chatsMap: Map<string, ChatDoc>;
  clientsMap: Map<string, ClientDoc>;
  onClick: () => void;
}): React.ReactNode {
  const source = hit._source as unknown as MessageSource | undefined;
  if (!source) {
    return null;
  }

  const chat = source.chat_id ? chatsMap.get(source.chat_id) : undefined;
  const client =
    source.client_id !== undefined && source.client_id !== null
      ? clientsMap.get(String(source.client_id))
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

// function useActiveSearch(
//   query: string,
//   scope: SearchScopeType,
//   semantic: boolean
// ) {
//   const allSearch = useSearchAll(query, {
//     semantic,
//     enabled: scope.type === "all" && query.length > 0,
//   });

//   const chatSearch = useSearchInChat(
//     scope.type === "chat" ? scope.chatId : "",
//     query,
//     {
//       semantic,
//       enabled: scope.type === "chat" && query.length > 0,
//     }
//   );

//   const clientSearch = useSearchInClient(
//     scope.type === "client" ? scope.clientId : 0,
//     query,
//     {
//       semantic,
//       enabled: scope.type === "client" && query.length > 0,
//     }
//   );

//   if (scope.type === "all") {
//     return allSearch;
//   }
//   if (scope.type === "chat") {
//     return chatSearch;
//   }
//   return clientSearch;
// }

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
  chatsMap: Map<string, ChatDoc>;
  clientsMap: Map<string, ClientDoc>;
  onSelectResult?: (result: { chatId: string; messageId?: string }) => void;
}): React.ReactNode {
  const { results, status, loadMore } = usePaginatedQuery(
    api.search.textByKeywords,
    { keywords: query, scope },
    { initialNumItems: 10 }
  )

  if (query.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
        Enter a search term to find messages
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
  // Convert paginated message docs into the SearchHit shape expected by
  // SearchResultItem.
  const pageResults = results ?? [];
  const hits = pageResults.map((m: any) => ({
    _id: (m._id ?? m.messageId ?? String(m.messageId ?? "")) as string,
    _index: "search_text",
    _score: null,
    _source: {
      id: (m.messageId ?? undefined) as string | undefined,
      external_id: (m.externalId ?? undefined) as string | undefined,
      chat_id: (m.chatId ?? undefined) as Id<"chats"> | undefined,
      client_id: (m.clientId ?? undefined) as Id<"clients"> | undefined,
      sender_id: (m.senderId ?? m.userId ?? undefined) as string | undefined,
      content: (m.text ?? null) as string | null,
      out: (m.outgoing ?? false) as boolean,
      created_at: m.timestamp ? Math.floor(m.timestamp / 1000) : undefined,
    },
  }));

  if (hits.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
        No results found for "{query}"
      </div>
    );
  }
  const isLoadingMore = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";

  return (
    <div className="space-y-1">
      <div className="px-3 py-2 text-muted-foreground text-xs">
        {hits.length} result{hits.length !== 1 ? "s" : ""} found
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

        {canLoadMore && (
          <div className="flex items-center justify-center py-2">
            <Button
              onClick={() => loadMore(10)}
              variant="outline"
              size="sm"
            >
              {isLoadingMore ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}
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

  const chats = useQuery(api.chats.list);
  const clients = useQuery(api.clients.list);

  const chatsMap = new Map<string, ChatDoc>();
  for (const chat of chats ?? []) {
    chatsMap.set(chat.chatId, chat);
  }

  const clientsMap = new Map<string, ClientDoc>();
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
            {clientsArray.map((client: ClientDoc) => (
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
            semantic={semantic}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
