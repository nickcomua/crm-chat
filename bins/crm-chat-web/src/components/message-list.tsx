import { useQuery } from "convex/react";
import { ArrowLeft, Ban, Image as ImageIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { api } from "@/lib/convex";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

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

function MessageBubble({ message }: { message: MessageDoc }): React.ReactNode {
  const isOutgoing = message.out;
  const isDeleted = message.deleted;

  return (
    <div className={cn("flex", isOutgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[70%] overflow-hidden rounded-2xl px-3.5 py-2 shadow-sm",
          isDeleted && "opacity-50",
          isOutgoing
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-card ring-1 ring-border/40"
        )}
      >
        {isDeleted && (
          <div className="mb-1 flex items-center gap-1 text-[11px] opacity-70">
            <Ban className="h-3 w-3" />
            <span className="italic">Deleted</span>
          </div>
        )}

        {(() => {
          if (message.text) {
            return (
              <p className="whitespace-pre-wrap break-all text-[13px] leading-relaxed">
                {message.text}
              </p>
            );
          }
          if (message.mediaId) {
            return (
              <div className="flex items-center gap-2 text-[13px]">
                <ImageIcon className="h-4 w-4 opacity-60" />
                <span className="italic opacity-70">Media</span>
              </div>
            );
          }
          return (
            <p className="text-[13px] italic opacity-50">[Empty message]</p>
          );
        })()}

        <div
          className={cn(
            "mt-0.5 text-right text-[10px]",
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
  const messages = useQuery(api.messages.listByChat, { chatId });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const chat = chats?.find((c: { chatId: string }) => c.chatId === chatId);
  const client = chat
    ? clients?.find((c: { _id: string }) => c._id === chat.clientId)
    : undefined;

  const sortedMessages: MessageDoc[] = messages
    ? [...messages].sort((a: MessageDoc, b: MessageDoc) => a.ts - b.ts)
    : [];
  const activeMessageCount = sortedMessages.filter((m) => !m.deleted).length;

  const prevChatIdRef = useRef(chatId);
  const prevMessageCountRef = useRef(sortedMessages.length);

  useEffect(() => {
    const chatChanged = prevChatIdRef.current !== chatId;
    const messagesChanged =
      prevMessageCountRef.current !== sortedMessages.length;

    if (chatChanged || messagesChanged) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      prevChatIdRef.current = chatId;
      prevMessageCountRef.current = sortedMessages.length;
    }
  });

  if (messages === undefined) {
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
              {activeMessageCount} message
              {activeMessageCount !== 1 ? "s" : ""}
              {activeMessageCount !== sortedMessages.length &&
                ` (${sortedMessages.length - activeMessageCount} deleted)`}
            </span>
          </p>
        </div>
      </div>

      <div className="messages-bg flex-1 overflow-y-auto p-4">
        {sortedMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground/60 text-sm">No messages yet</p>
          </div>
        ) : (
          <div className="space-y-2">
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
                  <MessageBubble message={message} />
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
