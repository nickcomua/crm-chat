import { usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { api } from "@/lib/convex";
import { cn } from "../lib/utils";
import { type MediaInfo, MediaRenderer } from "./media-renderer";
import { Button } from "./ui/button";

const PAGE_SIZE = 50;

interface MessageListProps {
  chatId: string;
  onBack?: () => void;
}

function formatMessageTime(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateHeader(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return "Today";
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }

  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function getChatDisplayName(
  chat: { pinnedName?: string; chatId: string } | undefined
): string {
  if (!chat) {
    return "Chat";
  }
  if (chat.pinnedName) {
    return chat.pinnedName;
  }
  return `Chat ${chat.chatId.slice(0, 8)}`;
}

function getClientDisplayName(
  client: { kind: string; externalId: string } | undefined
): string {
  if (!client) {
    return "";
  }
  return `${client.kind} • ${client.externalId}`;
}

interface MessageDoc {
  _id: string;
  messageId: string;
  text?: string;
  out: boolean;
  deleted: boolean;
  ts: number;
  mediaId?: string;
  mediaKind?: string;
  chatId: string;
}

function shouldShowDateHeader(
  message: MessageDoc,
  prevMessage: MessageDoc | undefined
): boolean {
  if (!prevMessage) {
    return true;
  }

  const messageDate = new Date(message.ts).toDateString();
  const prevDate = new Date(prevMessage.ts).toDateString();

  return messageDate !== prevDate;
}

function MessageBubble({
  message,
  media,
}: {
  message: MessageDoc;
  media?: MediaInfo;
}): React.ReactNode {
  const isOutgoing = message.out;
  const isDeleted = message.deleted;
  const hasMedia = media !== undefined;

  return (
    <div className={cn("flex", isOutgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[70%] overflow-hidden rounded-2xl shadow-sm",
          hasMedia ? "p-1" : "px-3.5 py-2",
          isDeleted && "opacity-50",
          isOutgoing
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-card ring-1 ring-border/40"
        )}
      >
        {isDeleted && (
          <div className="mb-1 flex items-center gap-1 px-2.5 pt-1 text-[11px] opacity-70">
            <Ban className="h-3 w-3" />
            <span className="italic">Deleted</span>
          </div>
        )}

        {hasMedia && <MediaRenderer isOutgoing={isOutgoing} media={media} />}

        {message.text && (
          <p
            className={cn(
              "whitespace-pre-wrap break-all text-[13px] leading-relaxed",
              hasMedia && "px-2.5 pt-1"
            )}
          >
            {message.text}
          </p>
        )}

        {!(message.text || hasMedia) && (
          <p className="text-[13px] italic opacity-50">[Empty message]</p>
        )}

        <div
          className={cn(
            "mt-0.5 text-right text-[10px]",
            hasMedia && "px-2.5 pb-1",
            isOutgoing
              ? "text-primary-foreground/50"
              : "text-muted-foreground/60"
          )}
        >
          {formatMessageTime(message.ts)}
        </div>
      </div>
    </div>
  );
}

export function MessageList({
  chatId,
  onBack,
}: MessageListProps): React.ReactNode {
  const chats = useQuery(api.chats.list);
  const clients = useQuery(api.clients.list);
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.listByChat,
    { chatId },
    { initialNumItems: PAGE_SIZE }
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevChatIdRef = useRef(chatId);
  const prevMessageCountRef = useRef(0);
  // True while waiting for older messages to arrive after loadMore.
  const loadingOlderRef = useRef(false);
  // Saved distance-from-bottom for scroll restoration after prepend.
  const savedDistRef = useRef(0);

  const chat = chats?.find((c: { chatId: string }) => c.chatId === chatId);
  const client = chat
    ? clients?.find((c: { _id: string }) => c._id === chat.clientId)
    : undefined;

  // Query returns desc (newest first); reverse for display (oldest at top).
  const sortedMessages = [...results].reverse() as MessageDoc[];
  const activeMessageCount = sortedMessages.filter((m) => !m.deleted).length;

  // Batch-query media records for messages that have media attached.
  const mediaMessageIds = sortedMessages
    .filter((m) => m.mediaId)
    .map((m) => m.messageId);
  const mediaRecords = useQuery(
    api.media.getForMessages,
    mediaMessageIds.length > 0 ? { messageIds: mediaMessageIds } : "skip"
  );
  const mediaMap = new Map<string, MediaInfo>();
  if (mediaRecords) {
    for (const record of mediaRecords) {
      mediaMap.set(record.messageId, record);
    }
  }

  // Restore scroll position after older messages are prepended.
  useLayoutEffect(() => {
    if (loadingOlderRef.current && scrollRef.current) {
      scrollRef.current.scrollTop =
        scrollRef.current.scrollHeight - savedDistRef.current;
      loadingOlderRef.current = false;
    }
  });

  // Scroll to bottom on chat switch or initial load only.
  useEffect(() => {
    const chatChanged = prevChatIdRef.current !== chatId;
    const isInitialLoad =
      prevMessageCountRef.current === 0 && sortedMessages.length > 0;

    if (chatChanged || isInitialLoad) {
      messagesEndRef.current?.scrollIntoView();
    }

    prevChatIdRef.current = chatId;
    prevMessageCountRef.current = sortedMessages.length;
  });

  // IntersectionObserver: preload older messages before user reaches the top.
  useEffect(() => {
    if (status !== "CanLoadMore") {
      return;
    }
    const sentinel = sentinelRef.current;
    const container = scrollRef.current;
    if (!(sentinel && container)) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          scrollRef.current &&
          !loadingOlderRef.current
        ) {
          savedDistRef.current =
            scrollRef.current.scrollHeight - scrollRef.current.scrollTop;
          loadingOlderRef.current = true;
          loadMore(PAGE_SIZE);
        }
      },
      // Trigger 1500px before sentinel enters the viewport so messages
      // are already loaded by the time the user scrolls there.
      { root: container, rootMargin: "1500px 0px 0px 0px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [status, loadMore]);

  if (status === "LoadingFirstPage") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-border/50 border-b px-4 py-2.5">
        {onBack && (
          <Button
            aria-label="Go back"
            className="h-8 w-8 md:hidden"
            onClick={onBack}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display font-semibold text-sm">
            {getChatDisplayName(chat)}
          </h2>
          <p className="truncate text-muted-foreground/70 text-xs">
            {client && (
              <span className="mr-1.5">{getClientDisplayName(client)}</span>
            )}
            <span>
              {activeMessageCount}
              {status !== "Exhausted" ? "+" : ""} message
              {activeMessageCount !== 1 ? "s" : ""}
              {activeMessageCount !== sortedMessages.length &&
                ` (${sortedMessages.length - activeMessageCount} deleted)`}
            </span>
          </p>
        </div>
      </div>

      <div className="messages-bg flex-1 overflow-y-auto p-4" ref={scrollRef}>
        {sortedMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground/60 text-sm">No messages yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Sentinel for infinite scroll — triggers loading older messages */}
            <div className="h-px" ref={sentinelRef} />
            {status === "LoadingMore" && (
              <div className="flex justify-center py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
              </div>
            )}
            {status === "Exhausted" && sortedMessages.length >= PAGE_SIZE && (
              <p className="py-2 text-center text-muted-foreground/40 text-xs">
                Beginning of conversation
              </p>
            )}
            {sortedMessages.map((message, index) => {
              const prevMessage = sortedMessages[index - 1];
              const showDateHeader = shouldShowDateHeader(message, prevMessage);

              return (
                <div key={message._id}>
                  {showDateHeader && (
                    <div className="my-5 flex items-center gap-3">
                      <div className="h-px flex-1 bg-border/50" />
                      <span className="font-medium text-[11px] text-muted-foreground/60 uppercase tracking-wider">
                        {formatDateHeader(message.ts)}
                      </span>
                      <div className="h-px flex-1 bg-border/50" />
                    </div>
                  )}
                  <MessageBubble
                    media={mediaMap.get(message.messageId)}
                    message={message}
                  />
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
