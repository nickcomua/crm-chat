"use no memo";

import { useVirtualizer } from "@tanstack/react-virtual";
import { usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/convex";
import { cn } from "../lib/utils";
import { type MediaInfo, MediaRenderer } from "./media-renderer";
import { Button } from "./ui/button";

const PAGE_SIZE = 8000;

interface MessageListProps {
  chatId: string;
  onBack?: () => void;
  targetMessageId?: string;
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
  client: { kind: string; telegramId: string } | undefined
): string {
  if (!client) {
    return "";
  }
  return `${client.kind} • ${client.telegramId}`;
}

interface MessageDoc {
  _id: string;
  messageId: string;
  text?: string;
  outgoing: boolean;
  deleted: boolean;
  timestamp: number;
  mediaExternalId?: string;
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

  const messageDate = new Date(message.timestamp).toDateString();
  const prevDate = new Date(prevMessage.timestamp).toDateString();

  return messageDate !== prevDate;
}

function MessageBubble({
  message,
  media,
  highlighted,
}: {
  message: MessageDoc;
  media?: MediaInfo;
  highlighted?: boolean;
}): React.ReactNode {
  const isOutgoing = message.outgoing;
  const isDeleted = message.deleted;
  const hasMedia = media !== undefined;

  return (
    <div className={cn("flex", isOutgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[70%] overflow-hidden rounded-2xl shadow-sm transition-colors duration-700",
          hasMedia ? "p-1" : "px-3.5 py-2",
          isDeleted && "opacity-50",
          highlighted &&
            "ring-2 ring-primary ring-offset-2 ring-offset-background",
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
          {formatMessageTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

export function MessageList({
  chatId,
  onBack,
  targetMessageId,
}: MessageListProps): React.ReactNode {
  const chats = useQuery(api.chats.list);
  const clients = useQuery(api.clients.list);
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.listByChat,
    { chatId },
    { initialNumItems: PAGE_SIZE }
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevChatIdRef = useRef(chatId);
  const prevCountRef = useRef(0);
  const isLoadingRef = useRef(false);
  const scrollAttemptedRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const prevTargetRef = useRef(targetMessageId);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const chat = chats?.find((c: { chatId: string }) => c.chatId === chatId);
  const client = chat
    ? clients?.find((c: { _id: string }) => c._id === chat.clientId)
    : undefined;

  // Query returns desc (newest first); reverse for display (oldest at top).
  const sortedMessages = [...results].reverse() as MessageDoc[];
  const activeMessageCount = sortedMessages.filter((m) => !m.deleted).length;

  // Single indexed scan for all media in this chat (avoids per-message reads
  // that hit Convex's 4096 read limit with large message sets).
  const mediaRecords = useQuery(api.media.getForChat, { chatId });
  const mediaMap = new Map<string, MediaInfo>();
  if (mediaRecords) {
    for (const record of mediaRecords) {
      mediaMap.set(record.messageId, record);
    }
  }

  // Virtualizer for the message list.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: sortedMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 15,
    getItemKey: (index) => sortedMessages[index]._id,
  });

  // Reset state when chat changes.
  useEffect(() => {
    prevChatIdRef.current = chatId;
    prevCountRef.current = 0;
    isLoadingRef.current = false;
    scrollAttemptedRef.current = false;
    initialScrollDoneRef.current = false;
    setHighlightedId(null);
  }, [chatId]);

  // Scroll to bottom on initial load (no scroll target).
  useEffect(() => {
    if (
      sortedMessages.length > 0 &&
      !initialScrollDoneRef.current &&
      !targetMessageId
    ) {
      initialScrollDoneRef.current = true;
      virtualizer.scrollToIndex(sortedMessages.length - 1, { align: "end" });
    }
  }, [sortedMessages.length, targetMessageId, virtualizer]);

  // Scroll-to-message: find the target, load more if needed, scroll instantly.
  // Also resets state when targetMessageId changes.
  useEffect(() => {
    // Reset when target changes.
    if (prevTargetRef.current !== targetMessageId) {
      prevTargetRef.current = targetMessageId;
      scrollAttemptedRef.current = false;
      setHighlightedId(null);
    }

    if (!targetMessageId || scrollAttemptedRef.current) {
      return;
    }

    const index = sortedMessages.findIndex(
      (m) => m.messageId === targetMessageId
    );

    if (index >= 0) {
      scrollAttemptedRef.current = true;
      initialScrollDoneRef.current = true;
      virtualizer.scrollToIndex(index, { align: "center", behavior: "auto" });
      setHighlightedId(targetMessageId);
      setTimeout(() => setHighlightedId(null), 2000);
    } else if (status === "CanLoadMore") {
      loadMore(PAGE_SIZE);
    } else if (status === "Exhausted") {
      // All messages loaded but target not found — give up.
      scrollAttemptedRef.current = true;
    }
    // Otherwise still loading (LoadingFirstPage / LoadingMore) — wait for
    // sortedMessages/status to change and re-run.
  }, [targetMessageId, sortedMessages, status, loadMore, virtualizer]);

  // Infinite scroll: load older messages when user scrolls near the top.
  // Uses scrollTop directly instead of virtualizer.getVirtualItems() because
  // virtual items can be stale during scroll events fired by scrollToIndex().
  const handleScroll = (): void => {
    if (status !== "CanLoadMore" || isLoadingRef.current) {
      return;
    }
    const el = scrollRef.current;
    if (el && el.scrollTop < 200) {
      isLoadingRef.current = true;
      loadMore(PAGE_SIZE);
    }
  };

  // Scroll preservation after older messages are prepended.
  useLayoutEffect(() => {
    const prevCount = prevCountRef.current;
    const currCount = sortedMessages.length;
    if (prevCount > 0 && currCount > prevCount && isLoadingRef.current) {
      const addedCount = currCount - prevCount;
      virtualizer.scrollToIndex(addedCount, { align: "start" });
      isLoadingRef.current = false;
    }
    prevCountRef.current = currCount;
  });

  if (status === "LoadingFirstPage") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

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

      <div
        className="messages-bg flex-1 overflow-y-auto"
        onScroll={handleScroll}
        ref={scrollRef}
      >
        {sortedMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground/60 text-sm">No messages yet</p>
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {status === "LoadingMore" && (
              <div className="absolute top-0 right-0 left-0 z-10 flex justify-center py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
              </div>
            )}
            {virtualItems.map((virtualRow) => {
              const message = sortedMessages[virtualRow.index];
              const prevMessage =
                virtualRow.index > 0
                  ? sortedMessages[virtualRow.index - 1]
                  : undefined;
              const showDateHeader = shouldShowDateHeader(message, prevMessage);
              const isFirst = virtualRow.index === 0;

              return (
                <div
                  data-index={virtualRow.index}
                  data-message-id={message.messageId}
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {isFirst &&
                    status === "Exhausted" &&
                    sortedMessages.length >= PAGE_SIZE && (
                      <p className="py-2 text-center text-muted-foreground/40 text-xs">
                        Beginning of conversation
                      </p>
                    )}
                  {showDateHeader && (
                    <div className="my-5 flex items-center gap-3 px-4">
                      <div className="h-px flex-1 bg-border/50" />
                      <span className="font-medium text-[11px] text-muted-foreground/60 uppercase tracking-wider">
                        {formatDateHeader(message.timestamp)}
                      </span>
                      <div className="h-px flex-1 bg-border/50" />
                    </div>
                  )}
                  <div className="px-4 py-1">
                    <MessageBubble
                      highlighted={highlightedId === message.messageId}
                      media={mediaMap.get(message.messageId)}
                      message={message}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
