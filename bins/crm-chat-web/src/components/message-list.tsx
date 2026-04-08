"use no memo";

import { useNavigate } from "@tanstack/react-router";
import {
  elementScroll,
  useVirtualizer,
  type VirtualizerOptions,
} from "@tanstack/react-virtual";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useQuery as useCachedQuery } from "convex-helpers/react/cache";
import { ArrowLeft, Loader2, UserPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useContactForChat } from "@/hooks/use-contact-for-chat";
import { api, onResultError } from "@/lib/convex";
import { displayChatName, displayClientName } from "@/utils/display";
import { formatDateHeader } from "@/utils/format";
import { cn } from "../lib/utils";
import { AttachDialogToContactDialog } from "./attach-dialog-to-contact";
import { CreateContactDialog } from "./create-contact-dialog";
import type { MediaInfo } from "./media-renderer";
import {
  MessageBubble,
  type MessageDoc,
  shouldShowDateHeader,
} from "./message-bubble";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const PAGE_SIZE = 8000;

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
  const orderedMessages = [...results].reverse() as MessageDoc[];

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

  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const highlight = useRef((messageId: string) => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    setHighlightedId(messageId);
    highlightTimeoutRef.current = setTimeout(
      () => setHighlightedId(null),
      1000
    );
  }).current;
  const clearHighlight = useRef(() => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    setHighlightedId(null);
  }).current;

  const [pendingTarget, setPendingTarget] = useState<ReturnType<
    typeof makeScrollRequest
  > | null>(null);
  const initialScrollDoneRef = useRef(false);
  const paginationRef = useRef({ lastCount: 0, areLoading: false });

  const [openCreateContact, setOpenCreateContact] = useState(false);
  const [openAttachContact, setOpenAttachContact] = useState(false);

  // Contacts linked to this chat (0 for unlinked dialogs, 1 for linked
  // 1:1s, 1+ for linked group chats).
  const { contacts: linkedContacts } = useContactForChat(chatId);

  // For v1, we target the FIRST linked contact for pin actions. Group chats
  // with multiple linked contacts will need a follow-up sub-menu per pin.
  const primaryContactId = linkedContacts[0]?.contactId;
  const pinnedMessageIds = useCachedQuery(
    api.model.contactPins.listPinnedMessageIdsForContact,
    primaryContactId ? { contactId: primaryContactId } : "skip"
  ) as string[] | undefined;
  const pinnedSet = useMemo(
    () => new Set(pinnedMessageIds ?? []),
    [pinnedMessageIds]
  );
  const pinMessage = useMutation(api.model.contactPins.pinMessage);
  const unpinMessage = useMutation(api.model.contactPins.unpinMessage);

  const chat = chats?.find((c: { chatId: string }) => c.chatId === chatId);
  const client = chat
    ? clients?.find((c: { _id: string }) => c._id === chat.clientId)
    : undefined;

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
        {chat && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Contact actions"
                className="h-8 w-8"
                size="icon"
                variant="ghost"
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setOpenCreateContact(true)}>
                Create contact from this dialog
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setOpenAttachContact(true)}>
                Attach to existing contact
              </DropdownMenuItem>
              {linkedContacts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {linkedContacts.length === 1 ? (
                    <DropdownMenuItem
                      onClick={() =>
                        navigate({
                          to: "/contacts/$contactId",
                          params: {
                            contactId: linkedContacts[0].contactId,
                          },
                        })
                      }
                    >
                      Go to contact ({linkedContacts[0].displayName})
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        Go to contact…
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {linkedContacts.map((c) => (
                          <DropdownMenuItem
                            key={c.contactId}
                            onClick={() =>
                              navigate({
                                to: "/contacts/$contactId",
                                params: { contactId: c.contactId },
                              })
                            }
                          >
                            {c.displayName}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
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
                  <div className="px-4 py-1">
                    <MessageBubble
                      highlighted={highlightedId === message.messageId}
                      isPinned={
                        primaryContactId !== undefined &&
                        pinnedSet.has(message.messageId)
                      }
                      media={mediaMap.get(message.messageId)}
                      message={message}
                      onPinToggle={
                        primaryContactId
                          ? () => {
                              const cid = primaryContactId;
                              if (pinnedSet.has(message.messageId)) {
                                unpinMessage({
                                  contactId: cid,
                                  messageId: message.messageId,
                                }).then(onResultError);
                              } else {
                                pinMessage({
                                  contactId: cid,
                                  messageId: message.messageId,
                                }).then(onResultError);
                              }
                            }
                          : undefined
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {chat && (
        <>
          <CreateContactDialog
            chat={{
              chatId: chat.chatId,
              chatType: chat.chatType as "Dialog" | "Group",
              pinnedName: chat.pinnedName,
            }}
            onOpenChange={setOpenCreateContact}
            open={openCreateContact}
          />
          <AttachDialogToContactDialog
            chat={{
              chatId: chat.chatId,
              chatType: chat.chatType as "Dialog" | "Group",
              pinnedName: chat.pinnedName,
            }}
            onOpenChange={setOpenAttachContact}
            open={openAttachContact}
          />
        </>
      )}
    </div>
  );
}
