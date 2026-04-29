import { useQuery } from "convex-helpers/react/cache";
import { Filter, MessageSquare, Pin, Search, User, Users } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/convex";
import {
	cn,
	getAvatarGradient,
	getChatDisplayName,
	getInitials,
} from "../lib/utils";
import { type MediaKind, mediaKindLabel } from "./media-types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface Client {
	_id: string;
	kind: string;
	telegramId: string;
}

interface ChatListProps {
	onSelectChat: (chatId: string) => void;
	selectedChatId: string | null;
}

function formatTimestamp(ts: number): string {
	const date = new Date(ts);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	if (isToday) {
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (date.toDateString() === yesterday.toDateString()) {
		return "Yesterday";
	}

	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getClientDisplayName(client: {
	kind: string;
	telegramId: string;
}): string {
	return `${client.kind} (${client.telegramId.slice(0, 8)}...)`;
}

function getTelegramIdColorStyle(telegramId: string): {
	background: string;
	color: string;
} {
	let hash = 0;
	for (let i = 0; i < telegramId.length; i++) {
		hash = telegramId.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	return {
		background: `oklch(0.65 0.18 ${hue} / 0.15)`,
		color: `oklch(0.5 0.18 ${hue})`,
	};
}

export function ChatList({
	selectedChatId,
	onSelectChat,
}: ChatListProps): React.ReactNode {
	const chats = useQuery(api.model.chats.list);
	const clients = useQuery(api.model.clients.list) as Client[] | undefined;
	const contactLinks = useQuery(api.model.contacts.listAllLinksForUser) as
		| Array<{
				chatId: string;
				contactId: string;
				contactDisplayName: string;
				senderId: string;
		  }>
		| undefined;
	const chatIds = chats?.map((c: { chatId: string }) => c.chatId);
	const lastMessages = useQuery(
		api.model.messages.getLastPerChat,
		chatIds ? { chatIds } : "skip",
	) as
		| Array<{
				chatId: string;
				text?: string;
				mediaExternalId?: string;
				mediaKind?: string;
		  }>
		| undefined;
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
	const [showClientFilter, setShowClientFilter] = useState(false);

	if (
		chats === undefined ||
		clients === undefined ||
		lastMessages === undefined
	) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
			</div>
		);
	}

	const clientsArray = Array.from(clients);

	const clientsMap = new Map<string, (typeof clients)[number]>();
	for (const client of clientsArray) {
		clientsMap.set(client._id, client);
	}

	const sortedChats = [...chats].sort((a, b) => {
		if (a.isPinned && !b.isPinned) {
			return -1;
		}
		if (!a.isPinned && b.isPinned) {
			return 1;
		}
		return b.lastMessageTimestamp - a.lastMessageTimestamp;
	});

	let filteredChats = sortedChats;

	if (selectedClientId !== null) {
		filteredChats = filteredChats.filter(
			(chat) => chat.clientId === selectedClientId,
		);
	}

	if (searchQuery.trim()) {
		const query = searchQuery.toLowerCase();
		filteredChats = filteredChats.filter((chat) => {
			const name = getChatDisplayName(chat).toLowerCase();
			return name.includes(query);
		});
	}

	const lastMessagesMap = new Map(lastMessages.map((m) => [m.chatId, m]));

	// Group contact links by chatId so each row can render a pill without
	// an O(N) scan. The reverse-index table makes this a single query.
	const contactLinksByChatId = new Map<
		string,
		Array<{ contactId: string; displayName: string }>
	>();
	for (const link of contactLinks ?? []) {
		const arr = contactLinksByChatId.get(link.chatId) ?? [];
		arr.push({
			contactId: link.contactId,
			displayName: link.contactDisplayName,
		});
		contactLinksByChatId.set(link.chatId, arr);
	}

	const getLastMessage = (chatId: string): string | null => {
		const entry = lastMessagesMap.get(chatId);
		if (!entry) {
			return null;
		}
		if (entry.text) {
			return entry.text;
		}
		if (entry.mediaKind) {
			return mediaKindLabel(entry.mediaKind as MediaKind);
		}
		if (entry.mediaExternalId) {
			return "[Media]";
		}
		return null;
	};

	if (chats.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center p-6 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
					<MessageSquare className="h-6 w-6 text-primary/50" />
				</div>
				<p className="mt-4 font-display font-medium text-muted-foreground text-sm">
					No chats yet
				</p>
				<p className="mt-1 text-muted-foreground/60 text-xs">
					Connect a Telegram client to see your chats
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col bg-sidebar">
			<div className="space-y-2 p-3">
				<div className="flex gap-2">
					<div className="relative flex-1">
						<Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							aria-label="Search chats"
							className="h-8 border-transparent bg-muted/60 pl-8 text-[13px] placeholder:text-muted-foreground/50 focus:border-border focus:bg-background"
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search chats..."
							type="search"
							value={searchQuery}
						/>
					</div>
					{clientsArray.length > 1 && (
						<Button
							aria-label="Filter clients"
							className={cn(
								"h-8 w-8",
								selectedClientId !== null && "bg-accent text-accent-foreground",
							)}
							onClick={() => setShowClientFilter(!showClientFilter)}
							size="icon"
							variant="outline"
						>
							<Filter className="h-3.5 w-3.5" />
						</Button>
					)}
				</div>

				{showClientFilter && clientsArray.length > 1 && (
					<div className="flex flex-wrap gap-1.5">
						<button
							className={cn(
								"rounded-md px-2 py-0.5 text-xs transition-colors",
								selectedClientId === null
									? "bg-primary text-primary-foreground"
									: "bg-muted text-muted-foreground hover:bg-muted/80",
							)}
							onClick={() => setSelectedClientId(null)}
							type="button"
						>
							All
						</button>
						{clientsArray.map((client) => (
							<button
								className={cn(
									"rounded-md px-2 py-0.5 text-xs transition-colors",
									selectedClientId === client._id
										? "bg-primary text-primary-foreground"
										: "bg-muted text-muted-foreground hover:bg-muted/80",
								)}
								key={client._id}
								onClick={() => setSelectedClientId(client._id)}
								type="button"
							>
								{getClientDisplayName(client)}
							</button>
						))}
					</div>
				)}
			</div>

			<div className="flex-1 overflow-y-auto px-1.5 pb-2">
				{filteredChats.length === 0 ? (
					<div className="p-4 text-center text-muted-foreground text-xs">
						No chats found
					</div>
				) : (
					<div className="space-y-px">
						{filteredChats.map((chat) => {
							const lastMessage = getLastMessage(chat.chatId);
							const isSelected = selectedChatId === chat.chatId;
							const client = clientsMap.get(chat.clientId);
							const displayName = getChatDisplayName(chat);

							return (
								<button
									className={cn(
										"group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all",
										isSelected ? "bg-accent/80" : "hover:bg-muted/40",
									)}
									key={chat._id}
									onClick={() => onSelectChat(chat.chatId)}
									type="button"
								>
									{isSelected && (
										<div className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
									)}

									<div className="relative shrink-0">
										<div
											className="flex h-9 w-9 items-center justify-center rounded-full font-medium text-white text-xs shadow-sm"
											style={{ background: getAvatarGradient(displayName) }}
										>
											{chat.chatType === "Group" ? (
												<Users className="h-4 w-4" />
											) : (
												getInitials(displayName)
											)}
										</div>
										{chat.photoUrl && (
											<img
												alt=""
												className="absolute inset-0 h-9 w-9 rounded-full object-cover shadow-sm"
												height={36}
												onError={(e) => {
													(e.target as HTMLImageElement).style.display = "none";
												}}
												src={chat.photoUrl}
												width={36}
											/>
										)}
										{chat.scanPhase === "Listening" && (
											<div className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-emerald-500" />
										)}
									</div>

									<div className="min-w-0 flex-1">
										<div className="flex items-center justify-between gap-2">
											<div className="flex min-w-0 items-center gap-1">
												{client?.kind === "Telegram" && (
													<i className="nf nf-fae-telegram shrink-0 text-blue-500 text-xs" />
												)}
												<span className="truncate font-medium text-[13px]">
													{displayName}
												</span>
												{chat.isPinned && (
													<Pin className="h-2.5 w-2.5 shrink-0 text-muted-foreground/60" />
												)}
											</div>
											<span className="shrink-0 text-[11px] text-muted-foreground/70">
												{formatTimestamp(chat.lastMessageTimestamp)}
											</span>
										</div>

										<div className="mt-px flex items-center gap-1.5">
											{client && (
												<span
													className="shrink-0 rounded px-1.5 py-px font-medium text-[10px]"
													style={getTelegramIdColorStyle(client.telegramId)}
												>
													{client.telegramId}
												</span>
											)}
											{lastMessage && (
												<p className="min-w-0 flex-1 truncate text-muted-foreground/70 text-xs">
													{lastMessage}
												</p>
											)}
										</div>
										{(() => {
											const linkedContacts = contactLinksByChatId.get(
												chat.chatId,
											);
											if (!linkedContacts || linkedContacts.length === 0) {
												return null;
											}
											// De-duplicate contacts (groups may have multiple
											// senders linked to the same contact).
											const uniqueByContactId = Array.from(
												new Map(
													linkedContacts.map((c) => [c.contactId, c]),
												).values(),
											);
											return (
												<div className="mt-0.5 flex flex-wrap gap-1">
													{uniqueByContactId.map((c) => (
														<span
															className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px font-medium text-[10px] text-primary"
															key={c.contactId}
														>
															<User className="h-2.5 w-2.5 shrink-0" />
															<span className="truncate">{c.displayName}</span>
														</span>
													))}
												</div>
											);
										})()}
									</div>
								</button>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
