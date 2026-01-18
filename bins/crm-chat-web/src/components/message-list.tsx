import { ArrowLeft, Ban, Image as ImageIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Infer } from "spacetimedb";
import { useTable } from "spacetimedb/react";
import { type Chat, type Client, type Message, tables } from "../lib/spacetime";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

type ChatType = Infer<typeof Chat>;
type ClientType = Infer<typeof Client>;
type MessageType = Infer<typeof Message>;

interface MessageListProps {
  chatId: string;
  onBack?: () => void;
}

function formatMessageTime(ts: bigint): string {
  const date = new Date(Number(ts) * 1000);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateHeader(ts: bigint): string {
  const date = new Date(Number(ts) * 1000);
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

function getChatDisplayName(chat: ChatType | undefined): string {
  if (!chat) {
    return "Chat";
  }
  if (chat.pinnedName) {
    return chat.pinnedName;
  }
  return `Chat ${chat.id.slice(0, 8)}`;
}

function getClientDisplayName(client: ClientType | undefined): string {
  if (!client) {
    return "";
  }
  return `${client.kind.tag} • ${client.externalId}`;
}

function shouldShowDateHeader(
  message: MessageType,
  prevMessage: MessageType | undefined
): boolean {
  if (!prevMessage) {
    return true;
  }

  const messageDate = new Date(Number(message.ts) * 1000).toDateString();
  const prevDate = new Date(Number(prevMessage.ts) * 1000).toDateString();

  return messageDate !== prevDate;
}

function MessageBubble({ message }: { message: MessageType }): React.ReactNode {
  const isOutgoing = message.out;
  const isDeleted = message.deleted;

  return (
    <div className={cn("flex", isOutgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-2",
          isDeleted && "opacity-60",
          isOutgoing
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted"
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
              <p className="whitespace-pre-wrap break-words text-sm">
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
  const [chats] = useTable(tables.chat);
  const [clients] = useTable(tables.client);
  const [messages] = useTable(tables.message);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const chat = Array.from(chats).find((c) => c.id === chatId);
  const client = chat
    ? Array.from(clients).find((c) => c.id === chat.clientId)
    : undefined;

  const chatMessages = Array.from(messages).filter((m) => m.chatId === chatId);
  const sortedMessages = chatMessages.sort((a, b) => Number(a.ts - b.ts));
  const activeMessageCount = sortedMessages.filter((m) => !m.deleted).length;

  // Scroll to bottom when chat changes or new messages arrive
  // Note: React Compiler handles memoization, so we use an empty dependency array
  // and track changes via a ref to avoid scrolling on every render
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
          <h2 className="truncate font-semibold">{getChatDisplayName(chat)}</h2>
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
                <div key={message.id}>
                  {showDateHeader && (
                    <div className="my-4 flex justify-center">
                      <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground text-xs">
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
