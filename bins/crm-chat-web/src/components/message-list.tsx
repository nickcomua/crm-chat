"use no memo";

import { useNavigate } from "@tanstack/react-router";
import {
  elementScroll,
  useVirtualizer,
  type VirtualizerOptions,
} from "@tanstack/react-virtual";
import { usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeft, Ban, Forward, Loader2, Reply } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Doc } from "@/lib/convex";
import { displayChatName, displayClientName } from "@/utils/display";
import { formatDateHeader, formatMessageTime } from "@/utils/format";
import { cn } from "../lib/utils";
import { type MediaInfo, MediaRenderer } from "./media-renderer";
import { Button } from "./ui/button";

const PAGE_SIZE = 8000;

interface ReactionDoc {
  count: number;
  emoji: string;
  recent: Array<{ userId: string }>;
}

function shouldShowDateHeader(
  message: Doc<"messages">,
  prevMessage: Doc<"messages"> | undefined
): boolean {
  if (!prevMessage) {
    return true;
  }

  const messageDate = new Date(message.timestamp).toDateString();
  const prevDate = new Date(prevMessage.timestamp).toDateString();

  return messageDate !== prevDate;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function getHighlightClasses(variant: number): {
  outline: string;
  bg: string;
} {
  const isEven = variant % 2 === 0;
  return {
    outline: isEven
      ? "animate-highlight-outline-a"
      : "animate-highlight-outline-b",
    bg: isEven ? "animate-highlight-bg-a" : "animate-highlight-bg-b",
  };
}

function getScrollAlign(
  index: number,
  scrollEl: HTMLElement | null,
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>
): "start" | "center" | "end" | null {
  const item = virtualizer.getVirtualItems().find((vi) => vi.index === index);
  if (!(scrollEl && item)) {
    return "center";
  }

  const viewTop = scrollEl.scrollTop;
  const viewHeight = scrollEl.clientHeight;
  const margin = viewHeight * 0.05;
  const boxTop = viewTop + margin;
  const boxBottom = viewTop + viewHeight - margin;

  if (item.start >= boxTop && item.end <= boxBottom) {
    return null;
  }
  if (item.start >= viewTop && item.end <= viewTop + viewHeight) {
    return item.start < boxTop ? "start" : "end";
  }
  return "center";
}
const scrollBehavior = ((): VirtualizerOptions<
  HTMLDivElement,
  Element
>["scrollToFn"] => {
  let rafId: number | null = null;
  return (offset, options, instance) => {
    const el = instance.scrollElement;
    if (!el) {
      return;
    }

    if (options.behavior !== "smooth") {
      elementScroll(offset, options, instance);
      return;
    }

    const startPos = el.scrollTop;
    const distance = offset - startPos;
    if (Math.abs(distance) < 1) {
      return;
    }

    const duration = 50;
    let startTime = -1;

    const step = (now: number): void => {
      if (startTime < 0) {
        startTime = now;
      }
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      el.scrollTop = startPos + distance * eased;
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      }
    };

    if (rafId) {
      cancelAnimationFrame(rafId);
    }
    rafId = requestAnimationFrame(step);
  };
})();

function ReactionBadges({
  hasMedia,
  isOutgoing,
  reactions,
}: {
  hasMedia: boolean;
  isOutgoing: boolean;
  reactions: ReactionDoc[];
}): React.ReactNode {
  if (reactions.length === 0) {
    return null;
  }
  return (
    <div
      className={cn("mt-1 flex flex-wrap gap-1", hasMedia && "px-2 pb-1")}
      data-testid="reactions"
    >
      {reactions.map((reaction) => (
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px]",
            isOutgoing
              ? "bg-primary-foreground/15 text-primary-foreground/80"
              : "bg-muted text-muted-foreground"
          )}
          data-testid="reaction-badge"
          key={reaction.emoji}
        >
          <span>{reaction.emoji}</span>
          <span>{reaction.count}</span>
        </span>
      ))}
    </div>
  );
}

function ReplyPreview({
  hasMedia,
  isOutgoing,
  onClick,
  text,
}: {
  hasMedia: boolean;
  isOutgoing: boolean;
  onClick?: () => void;
  text?: string;
}): React.ReactNode {
  return (
    <button
      className={cn(
        "mb-1 w-full rounded-md border-l-2 px-2 py-1 text-left text-[11px]",
        hasMedia ? "mx-1.5 mt-1" : "",
        isOutgoing
          ? "border-primary-foreground/40 bg-primary-foreground/10 text-primary-foreground/70"
          : "border-muted-foreground/40 bg-muted/50 text-muted-foreground"
      )}
      data-testid="reply-preview"
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center gap-1">
        <Reply className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {text ? truncateText(text, 100) : "Reply"}
        </span>
      </div>
    </button>
  );
}

function MessageListItem({
  message,
  media,
  highlight,
  replyText,
  onReplyClick,
}: {
  message: Doc<"messages">;
  media?: MediaInfo;
  highlight?: { method: "flash"; variant: number };
  replyText?: string;
  onReplyClick?: () => void;
}): React.ReactNode {
  const isOutgoing = message.outgoing;
  const isDeleted = message.deleted;
  const hasMedia = media !== undefined;
  const hlClasses = highlight ? getHighlightClasses(highlight.variant) : null;

  return (
    <div className={cn("px-4 py-1", hlClasses?.bg)}>
      <div className={cn("flex", isOutgoing ? "justify-end" : "justify-start")}>
        <div
          className={cn(
            "max-w-[70%] overflow-hidden rounded-2xl shadow-sm",
            hasMedia ? "p-1" : "px-3.5 py-2",
            isDeleted && "opacity-50",
            hlClasses?.outline,
            isOutgoing
              ? "rounded-br-md bg-primary text-primary-foreground"
              : "rounded-bl-md bg-card ring-1 ring-border/40"
          )}
        >
          {message.forwardedFrom && (
            <div
              className={cn(
                "mb-1 flex items-center gap-1 text-[11px]",
                hasMedia ? "px-2.5 pt-1" : "",
                isOutgoing
                  ? "text-primary-foreground/70"
                  : "text-muted-foreground"
              )}
              data-testid="forwarded-from"
            >
              <Forward className="h-3 w-3" />
              <span className="italic">
                Forwarded from {message.forwardedFrom.senderName}
              </span>
            </div>
          )}

          {message.replyToMessageId && (
            <ReplyPreview
              hasMedia={hasMedia}
              isOutgoing={isOutgoing}
              onClick={onReplyClick}
              text={replyText}
            />
          )}

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

          {message.reactions && (
            <ReactionBadges
              hasMedia={hasMedia}
              isOutgoing={isOutgoing}
              reactions={message.reactions}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function makeScrollRequest(messageId: string) {
  return /* scrollTo: */ { messageId, _aux: Date.now() };
}
export function MessageList({
  chatId,
  onBack,
  scrollTo,
}: {
  chatId: string;
  onBack?: () => void;
  scrollTo?: ReturnType<typeof makeScrollRequest>;
}): React.ReactNode {
  const navigate = useNavigate();

  const chats = useQuery(api.model.chats.list);
  const clients = useQuery(api.model.clients.list);
  const { results, status, loadMore } = usePaginatedQuery(
    api.model.messages.listByChat,
    { chatId },
    { initialNumItems: PAGE_SIZE }
  );
  const orderedMessages = [...results].reverse() as Doc<"messages">[];

  const msgContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: orderedMessages.length,
    getScrollElement: () => msgContainerRef.current,
    estimateSize: () => 64,
    overscan: 15,
    getItemKey: (index) => orderedMessages[index]._id,
    scrollToFn: scrollBehavior,
  });

  const [highlightState, setHighlight] = useState<{
    messageId: string;
    method: "flash";
    variant: number;
  } | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const highlight = useRef((messageId: string) => {
    console.log("hi");
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    setHighlight((prev) => ({
      messageId,
      method: "flash" as const,
      variant: (prev?.variant ?? -1) + 1,
    }));
    highlightTimeoutRef.current = setTimeout(() => setHighlight(null), 1000);
  }).current;
  const clearHighlight = useRef(() => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    setHighlight(null);
  }).current;

  const [pendingTarget, setPendingTarget] = useState<ReturnType<
    typeof makeScrollRequest
  > | null>(null);
  const initialScrollDoneRef = useRef(false);
  const paginationRef = useRef({ lastCount: 0, areLoading: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger
  useEffect(() => {
    initialScrollDoneRef.current = false;
    setPendingTarget(null);
    clearHighlight();
  }, [chatId]);

  useEffect(() => {
    if (
      orderedMessages.length > 0 &&
      !initialScrollDoneRef.current &&
      !scrollTo &&
      !pendingTarget
    ) {
      initialScrollDoneRef.current = true;
      virtualizer.scrollToIndex(orderedMessages.length - 1, { align: "end" });
    }
  }, [orderedMessages.length, scrollTo, pendingTarget, virtualizer]);

  useEffect(() => {
    if (scrollTo) {
      initialScrollDoneRef.current = true;
      navigate({
        to: "/chats/$chatId",
        params: { chatId },
        search: {},
        replace: true,
      });
      setPendingTarget(scrollTo);
    }
  }, [scrollTo, navigate, chatId]);

  useEffect(() => {
    if (!pendingTarget) {
      return;
    }

    const index = orderedMessages.findIndex(
      (m) => m.messageId === pendingTarget.messageId
    );
    if (index >= 0) {
      initialScrollDoneRef.current = true;
      const align = getScrollAlign(index, msgContainerRef.current, virtualizer);
      if (align) {
        virtualizer.scrollToIndex(index, { align, behavior: "smooth" });
      }
      highlight(pendingTarget.messageId);
      setPendingTarget(null);
    } else if (status === "CanLoadMore") {
      loadMore(PAGE_SIZE);
    } else if (status === "Exhausted") {
      setPendingTarget(null);
      // Notify for absent message
    } else {
      // Waiting to load here
    }
  }, [
    pendingTarget,
    orderedMessages,
    status,
    loadMore,
    virtualizer,
    highlight,
  ]);

  const handleScroll = (): void => {
    if (status !== "CanLoadMore" || paginationRef.current.areLoading) {
      return;
    }
    const el = msgContainerRef.current;
    if (el && el.scrollTop < 200) {
      paginationRef.current.areLoading = true;
      loadMore(PAGE_SIZE);
    }
  };

  // Scroll preservation after older messages are prepended.
  useLayoutEffect(() => {
    const p = paginationRef.current;
    const currCount = orderedMessages.length;
    if (p.lastCount > 0 && currCount > p.lastCount && p.areLoading) {
      const addedCount = currCount - p.lastCount;
      virtualizer.scrollToIndex(addedCount, { align: "start" });
      p.areLoading = false;
    }
    p.lastCount = currCount;
  });

  const chat = chats?.find((c: { chatId: string }) => c.chatId === chatId);
  const client = chat
    ? clients?.find((c: { _id: string }) => c._id === chat.clientId)
    : undefined;
  const messageTextMap = new Map<string, string>();
  for (const msg of orderedMessages) {
    if (msg.text) {
      messageTextMap.set(msg.messageId, msg.text);
    }
  }
  const activeMessageCount = orderedMessages.filter((m) => !m.deleted).length;

  // Single indexed scan for all media in this chat (avoids per-message reads
  // that hit Convex's 4096 read limit with large message sets).
  const mediaRecords = useQuery(api.model.media.getForChat, { chatId });
  const mediaMap = new Map<string, MediaInfo>();
  if (mediaRecords) {
    for (const record of mediaRecords) {
      mediaMap.set(record.messageId, record);
    }
  }

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
            {displayChatName(chat)}
          </h2>
          <p className="truncate text-muted-foreground/70 text-xs">
            {client && (
              <span className="mr-1.5">{displayClientName(client)}</span>
            )}
            <span>
              {activeMessageCount}
              {status === "Exhausted" ? "" : "+"} message
              {activeMessageCount === 1 ? "" : "s"}
              {activeMessageCount !== orderedMessages.length &&
                ` (${orderedMessages.length - activeMessageCount} deleted)`}
            </span>
          </p>
        </div>
      </div>

      <div
        className="messages-bg flex-1 overflow-y-auto"
        onScroll={handleScroll}
        ref={msgContainerRef}
      >
        {orderedMessages.length === 0 ? (
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
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const message = orderedMessages[virtualRow.index];
              const prevMessage =
                virtualRow.index > 0
                  ? orderedMessages[virtualRow.index - 1]
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
                    orderedMessages.length >= PAGE_SIZE && (
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
                  <MessageListItem
                    highlight={
                      highlightState?.messageId === message.messageId
                        ? highlightState
                        : undefined
                    }
                    media={mediaMap.get(message.messageId)}
                    message={message}
                    onReplyClick={
                      message.replyToMessageId
                        ? () => {
                            if (message.replyToMessageId) {
                              setPendingTarget(
                                makeScrollRequest(message.replyToMessageId)
                              );
                            }
                          }
                        : undefined
                    }
                    replyText={
                      message.replyToMessageId
                        ? messageTextMap.get(message.replyToMessageId)
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
