import { Ban, Forward, Pin, PinOff, Reply } from "lucide-react";
import { cn } from "@/lib/utils";
import { type MediaInfo, MediaRenderer } from "./media-renderer";
import { Badge } from "./ui/badge";

export interface ReactionDoc {
  count: number;
  emoji: string;
  recent: Array<{ userId: string }>;
}

export interface ForwardedFromDoc {
  date?: number;
  senderName: string;
}

export interface MessageDoc {
  _id: string;
  chatId: string;
  deleted: boolean;
  forwardedFrom?: ForwardedFromDoc;
  mediaExternalId?: string;
  mediaKind?: string;
  messageId: string;
  outgoing: boolean;
  reactions?: ReactionDoc[];
  replyToMessageId?: string;
  replyToText?: string;
  text?: string;
  timestamp: number;
}

export function shouldShowDateHeader(
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

export function ReactionBadges({
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

function formatMessageTime(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function ReplyPreview({
  replyToText,
  replyToMessageId,
  hasMedia,
  isOutgoing,
  onReplyClick,
}: {
  replyToText: string;
  replyToMessageId?: string;
  hasMedia: boolean;
  isOutgoing: boolean;
  onReplyClick?: (replyToMessageId: string) => void;
}): React.ReactNode {
  const canNavigate = Boolean(onReplyClick && replyToMessageId);
  const className = cn(
    "mb-1 rounded-md border-l-2 px-2 py-1 text-left text-[11px]",
    hasMedia ? "mx-1.5 mt-1" : "",
    canNavigate && "w-full cursor-pointer hover:bg-opacity-80",
    isOutgoing
      ? "border-primary-foreground/40 bg-primary-foreground/10 text-primary-foreground/70"
      : "border-muted-foreground/40 bg-muted/50 text-muted-foreground"
  );
  const inner = (
    <div className="flex items-center gap-1">
      <Reply className="h-3 w-3 shrink-0" />
      <span className="truncate">{truncateText(replyToText, 100)}</span>
    </div>
  );
  if (canNavigate && replyToMessageId) {
    return (
      <button
        aria-label="Go to replied message"
        className={className}
        data-testid="reply-preview"
        onClick={() => onReplyClick?.(replyToMessageId)}
        type="button"
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={className} data-testid="reply-preview">
      {inner}
    </div>
  );
}

interface MessageBubbleProps {
  /** Optional label (usually the chat name) shown as a small badge on the
   *  bubble. Used by the merged-timeline view to attribute the message. */
  chatLabel?: string;
  highlighted?: boolean;
  /** When true, renders a small pin indicator and marks the bubble as pinned. */
  isPinned?: boolean;
  media?: MediaInfo;
  message: MessageDoc;
  /** When provided, renders a pin toggle in the hover action cluster. */
  onPinToggle?: () => void;
  /** When provided, the reply preview becomes a button that invokes this with
   *  the replied-to message id (enabling scroll-to-parent navigation). */
  onReplyClick?: (replyToMessageId: string) => void;
}

export function MessageBubble({
  message,
  media,
  highlighted,
  chatLabel,
  onPinToggle,
  isPinned,
  onReplyClick,
}: MessageBubbleProps): React.ReactNode {
  const isOutgoing = message.outgoing;
  const isDeleted = message.deleted;
  const hasMedia = media !== undefined;

  return (
    <div className={cn("flex", isOutgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "group/bubble relative max-w-[70%] overflow-hidden rounded-2xl shadow-sm transition-colors duration-700",
          hasMedia ? "p-1" : "px-3.5 py-2",
          isDeleted && "opacity-50",
          highlighted &&
            "ring-2 ring-primary ring-offset-2 ring-offset-background",
          isOutgoing
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-card ring-1 ring-border/40"
        )}
      >
        {chatLabel && (
          <div
            className={cn(
              "mb-1 flex items-center gap-1",
              hasMedia && "px-2 pt-1"
            )}
          >
            <Badge
              className={cn(
                "h-4 px-1.5 text-[10px]",
                isOutgoing
                  ? "bg-primary-foreground/15 text-primary-foreground/80"
                  : ""
              )}
              variant={isOutgoing ? "ghost" : "secondary"}
            >
              {chatLabel}
            </Badge>
            {isPinned && (
              <Pin
                aria-label="Pinned to contact"
                className={cn(
                  "h-2.5 w-2.5",
                  isOutgoing
                    ? "text-primary-foreground/80"
                    : "text-muted-foreground/70"
                )}
              />
            )}
          </div>
        )}
        {!chatLabel && isPinned && (
          <div
            className={cn(
              "absolute top-1 right-1 flex items-center",
              hasMedia && "top-2 right-2"
            )}
          >
            <Pin
              aria-label="Pinned to contact"
              className={cn(
                "h-3 w-3",
                isOutgoing
                  ? "text-primary-foreground/80"
                  : "text-muted-foreground/70"
              )}
            />
          </div>
        )}

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

        {message.replyToText && (
          <ReplyPreview
            hasMedia={hasMedia}
            isOutgoing={isOutgoing}
            onReplyClick={onReplyClick}
            replyToMessageId={message.replyToMessageId}
            replyToText={message.replyToText}
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

        {onPinToggle && (
          <button
            aria-label={isPinned ? "Unpin from contact" : "Pin to contact"}
            className={cn(
              "absolute top-1 opacity-0 transition-opacity focus:opacity-100 group-hover/bubble:opacity-100",
              isOutgoing ? "left-1" : "right-1",
              "flex h-6 w-6 items-center justify-center rounded-full",
              isOutgoing
                ? "bg-primary-foreground/10 text-primary-foreground/80 hover:bg-primary-foreground/20"
                : "bg-muted text-muted-foreground hover:bg-muted-foreground/10"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onPinToggle();
            }}
            type="button"
          >
            {isPinned ? (
              <PinOff className="h-3 w-3" />
            ) : (
              <Pin className="h-3 w-3" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
