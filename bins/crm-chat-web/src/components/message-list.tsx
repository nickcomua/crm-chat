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
          "max-w-[75%] rounded-2xl px-4 py-2 shadow-sm",
          isDeleted && "opacity-60",
          isOutgoing
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-card ring-1 ring-border/50"
        )}
      >
        {isDeleted && (
          <div className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
            <Ban className="h-3 w-3" />
            <span className="italic">Deleted</span>
          </div>
        )}

        {(() => {
          if (message.text) {
            return (
              <p className="wrap-break-word whitespace-pre-wrap text-sm">
                {message.text}
              </p>
            );
          }
          if (message.mediaId) {
            return (
              <div className="flex items-center gap-2 text-sm">
                <ImageIcon className="h-4 w-4" />
                <span>Media</span>
              </div>
            );
          }
          return (
            <p className="text-muted-foreground text-sm italic">
              [Empty message]
            </p>
          );
        })()}

        <div
          className={cn(
            "mt-1 text-right text-xs",
            isOutgoing ? "text-primary-foreground/70" : "text-muted-foreground"
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

  // Scroll to bottom when chat changes or new messages arrive
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
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        {onBack && (
          <Button
            aria-label="Go back"
            className="md:hidden"
            onClick={onBack}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display font-semibold">
            {getChatDisplayName(chat)}
          </h2>
          <p className="truncate text-muted-foreground text-sm">
            {client && (
              <span className="mr-2">{getClientDisplayName(client)}</span>
            )}
            <span>
              • {activeMessageCount} message
              {activeMessageCount !== 1 ? "s" : ""}
              {activeMessageCount !== sortedMessages.length &&
                ` (${sortedMessages.length - activeMessageCount} deleted)`}
            </span>
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {sortedMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground">No messages yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedMessages.map((message, index) => {
              const prevMessage = sortedMessages[index - 1];
              const showDateHeader = shouldShowDateHeader(message, prevMessage);

              return (
                <div key={message._id}>
                  {showDateHeader && (
                    <div className="my-4 flex justify-center">
                      <span className="rounded-full bg-primary/10 px-3 py-1 font-medium text-primary/80 text-xs">
                        {formatDateHeader(message.ts)}
                      </span>
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
