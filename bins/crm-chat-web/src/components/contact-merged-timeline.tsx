"use no memo";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useRef } from "react";
import { api, type Id, onResultError } from "@/lib/convex";
import type { MediaInfo } from "./media-renderer";
import {
	MessageBubble,
	type MessageDoc,
	shouldShowDateHeader,
} from "./message-bubble";

const PAGE_SIZE = 1000;

interface ContactMergedTimelineProps {
	contactId: Id<"contacts">;
	targetMessageId?: string;
}

/** Shape of the `page` entries returned by `contacts.listMergedMessages`. */
interface MergedMessage extends MessageDoc {
	chatDisplayName: string;
	contactPinned: boolean;
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

/**
 * Merged 1:1 dialog timeline for a contact.
 *
 * Uses `usePaginatedQuery` from `convex/react` to page through the merged
 * view. The response shape differs slightly from `messages.listByChat` —
 * each message carries a `chatDisplayName` (rendered as a per-bubble badge)
 * and a `contactPinned` flag. An `isDegraded` sentinel on the response is
 * surfaced as a banner; Convex's paginated contract ignores extra fields,
 * but we still need it, so we piggyback on the first-page response by
 * re-running a non-paginated helper query for the flag.
 */
export function ContactMergedTimeline({
	contactId,
	targetMessageId: _targetMessageId,
}: ContactMergedTimelineProps): React.ReactNode {
	const { results, status, loadMore } = usePaginatedQuery(
		api.model.contacts.listMergedMessages,
		{ contactId },
		{ initialNumItems: PAGE_SIZE },
	);

	// Fetch the contact + links once so we can pull the set of linked chat ids
	// for the multi-chat media query.
	const contactData = useQuery(api.model.contacts.get, { contactId });

	const linkedChatIds =
		contactData?.links
			.map((l) => l.chatId)
			.filter((v, i, a) => a.indexOf(v) === i) ?? [];

	// One indexed scan per chat for all media in this merged view.
	const mediaRecords = useQuery(
		api.model.media.getForChats,
		linkedChatIds.length > 0 ? { chatIds: linkedChatIds } : "skip",
	);
	const mediaMap = new Map<string, MediaInfo>();
	if (mediaRecords) {
		for (const record of mediaRecords) {
			mediaMap.set(record.messageId, record);
		}
	}

	// Pinned-message id set (used as a fallback check; the backend already
	// sets `contactPinned` per row, but this is useful for optimistic updates).
	const pinnedIds = useQuery(
		api.model.contactPins.listPinnedMessageIdsForContact,
		{ contactId },
	);
	const pinnedIdSet = new Set(pinnedIds ?? []);

	const pinMessage = useMutation(api.model.contactPins.pinMessage);
	const unpinMessage = useMutation(api.model.contactPins.unpinMessage);

	const scrollRef = useRef<HTMLDivElement>(null);

	// Query returns desc (newest first); reverse for display (oldest at top).
	const sortedMessages = [...results].reverse() as MergedMessage[];

	const virtualizer = useVirtualizer({
		count: sortedMessages.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 72,
		overscan: 15,
		getItemKey: (index) => sortedMessages[index]._id,
	});

	const handleScroll = (): void => {
		if (status !== "CanLoadMore") {
			return;
		}
		const el = scrollRef.current;
		if (el && el.scrollTop < 200) {
			loadMore(PAGE_SIZE);
		}
	};

	const handlePinToggle = (message: MergedMessage): void => {
		if (pinnedIdSet.has(message.messageId)) {
			unpinMessage({ contactId, messageId: message.messageId }).then(
				onResultError,
			);
		} else {
			pinMessage({ contactId, messageId: message.messageId }).then(
				onResultError,
			);
		}
	};

	// Degraded flag — the backend returns `isDegraded` on the pagination
	// response, but `usePaginatedQuery` hides non-standard fields. As a
	// lightweight approximation, we show the banner when the linked-chat
	// count exceeds the backend cap (40).
	const isDegraded = linkedChatIds.length > 40;

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
			{isDegraded && (
				<div className="flex items-center gap-2 border-border/40 border-b bg-amber-500/10 px-4 py-2 text-amber-700 text-xs dark:text-amber-300">
					<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
					<span>
						This contact is linked to many dialogs. Only the 40 most recently
						active are shown in the merged view.
					</span>
				</div>
			)}

			<div
				className="messages-bg flex-1 overflow-y-auto"
				onScroll={handleScroll}
				ref={scrollRef}
			>
				{sortedMessages.length === 0 ? (
					<div className="flex h-full items-center justify-center">
						<p className="text-muted-foreground/60 text-sm">
							No messages to show for this contact yet.
						</p>
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
											chatLabel={message.chatDisplayName}
											isPinned={
												message.contactPinned ||
												pinnedIdSet.has(message.messageId)
											}
											media={mediaMap.get(message.messageId)}
											message={message}
											onPinToggle={() => handlePinToggle(message)}
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
