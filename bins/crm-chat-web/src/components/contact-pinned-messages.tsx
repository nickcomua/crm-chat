import { useNavigate } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery } from "convex/react";
import { AlertTriangle, PinOff } from "lucide-react";
import { api, type Id, onResultError } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface ContactPinnedMessagesProps {
	contactId: Id<"contacts">;
}

interface PinSnapshot {
	text?: string;
	timestamp: number;
	senderId: string;
	outgoing: boolean;
	mediaKind?: string;
	mediaExternalId?: string;
	chatDisplayNameAtPinTime?: string;
}

interface PinRow {
	_id: Id<"contactPins">;
	contactId: Id<"contacts">;
	messageId: string;
	chatId: string;
	snapshot: PinSnapshot;
	note?: string;
	pinnedAt: number;
	isOrphaned: boolean;
}

function formatTimestamp(ts: number): string {
	const date = new Date(ts);
	return date.toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function PinnedMessageCard({
	pin,
	contactId,
	onUnpin,
}: {
	pin: PinRow;
	contactId: Id<"contacts">;
	onUnpin: () => void;
}): React.ReactNode {
	const navigate = useNavigate();

	const handleClick = (): void => {
		if (pin.isOrphaned) {
			return;
		}
		navigate({
			to: "/contacts/$contactId",
			params: { contactId },
			search: {
				dialogId: pin.chatId,
				pinnedMessageId: pin.messageId,
			},
		});
	};

	return (
		<div
			className={cn(
				"group/pin relative rounded-lg border border-border/50 bg-card/50 p-3",
				pin.isOrphaned ? "opacity-70" : "hover:bg-card",
			)}
		>
			<div className="mb-1 flex items-start justify-between gap-2">
				<div className="flex min-w-0 flex-1 items-center gap-1.5">
					{pin.snapshot.chatDisplayNameAtPinTime && (
						<span className="truncate font-medium text-[11px] text-muted-foreground">
							{pin.snapshot.chatDisplayNameAtPinTime}
						</span>
					)}
					{pin.snapshot.mediaKind && (
						<Badge className="h-4 px-1.5 text-[10px]" variant="secondary">
							{pin.snapshot.mediaKind}
						</Badge>
					)}
					{pin.snapshot.outgoing && (
						<Badge className="h-4 px-1.5 text-[10px]" variant="outline">
							you
						</Badge>
					)}
				</div>
				<Button
					aria-label="Unpin message"
					className="h-6 w-6 opacity-0 transition-opacity group-hover/pin:opacity-100"
					onClick={(e) => {
						e.stopPropagation();
						onUnpin();
					}}
					size="icon"
					variant="ghost"
				>
					<PinOff className="h-3 w-3" />
				</Button>
			</div>

			<button
				className="block w-full cursor-pointer text-left disabled:cursor-default"
				disabled={pin.isOrphaned}
				onClick={handleClick}
				type="button"
			>
				{pin.snapshot.text ? (
					<p className="line-clamp-3 whitespace-pre-wrap break-words text-[12px]">
						{pin.snapshot.text}
					</p>
				) : (
					<p className="text-[12px] italic text-muted-foreground/60">
						[No text]
					</p>
				)}
			</button>

			{pin.note && (
				<p className="mt-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
					Note: {pin.note}
				</p>
			)}

			<div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/60">
				<span>{formatTimestamp(pin.snapshot.timestamp)}</span>
				<span>pinned {formatTimestamp(pin.pinnedAt)}</span>
			</div>

			{pin.isOrphaned && (
				<div className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
					<AlertTriangle className="h-3 w-3" />
					Original message no longer available
				</div>
			)}
		</div>
	);
}

export function ContactPinnedMessages({
	contactId,
}: ContactPinnedMessagesProps): React.ReactNode {
	const { results, status, loadMore } = usePaginatedQuery(
		api.model.contactPins.listForContact,
		{ contactId },
		{ initialNumItems: 50 },
	);

	const unpinMessage = useMutation(api.model.contactPins.unpinMessage);

	const handleUnpin = (messageId: string): void => {
		unpinMessage({ contactId, messageId }).then(onResultError);
	};

	return (
		<section className="pt-4">
			<header className="mb-2 flex items-center justify-between">
				<h3 className="font-display font-medium text-sm">
					Pinned interactions
				</h3>
			</header>

			{status === "LoadingFirstPage" ? (
				<div className="flex items-center justify-center py-6">
					<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
				</div>
			) : results.length === 0 ? (
				<p className="py-3 text-muted-foreground/70 text-xs">
					No pinned messages yet.
				</p>
			) : (
				<div className="space-y-2">
					{(results as unknown as PinRow[]).map((pin) => (
						<PinnedMessageCard
							contactId={contactId}
							key={pin._id}
							onUnpin={() => handleUnpin(pin.messageId)}
							pin={pin}
						/>
					))}
					{status === "CanLoadMore" && (
						<Button
							className="w-full"
							onClick={() => loadMore(50)}
							size="sm"
							variant="outline"
						>
							Load more
						</Button>
					)}
				</div>
			)}
		</section>
	);
}
