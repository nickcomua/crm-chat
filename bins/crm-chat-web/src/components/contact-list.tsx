import { useQuery } from "convex-helpers/react/cache";
import { Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Id } from "@/lib/convex";
import { cn, getAvatarGradient, getInitials } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";

interface ContactListProps {
	onSelectContact: (contactId: Id<"contacts"> | null) => void;
	selectedContactId: Id<"contacts"> | null;
}

interface ContactListRow {
	_id: Id<"contacts">;
	displayName: string;
	linkedChatCount: number;
	linkedSenderCount: number;
	lastInteractionAt?: number;
	lastMessagePreview?: string;
	lastMessageChatDisplayName?: string;
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

export function ContactList({
	selectedContactId,
	onSelectContact,
}: ContactListProps): React.ReactNode {
	const contacts = useQuery(api.model.contacts.list) as
		| ContactListRow[]
		| undefined;
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");

	// Debounce server-side custom-field search by 250ms.
	useEffect(() => {
		const h = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 250);
		return () => clearTimeout(h);
	}, [searchQuery]);

	const customFieldMatches = useQuery(
		api.model.contacts.searchByCustomFields,
		debouncedQuery.length >= 2 ? { query: debouncedQuery } : "skip",
	) as Array<{ _id: Id<"contacts"> }> | undefined;

	const filteredContacts = useMemo(() => {
		if (!contacts) {
			return [];
		}
		const query = searchQuery.trim().toLowerCase();
		if (query.length === 0) {
			return contacts;
		}

		const nameMatches = contacts.filter((c) =>
			c.displayName.toLowerCase().includes(query),
		);

		if (!customFieldMatches || customFieldMatches.length === 0) {
			return nameMatches;
		}

		// Merge by _id, preserving the main list's order (which reflects
		// lastInteractionAt desc) and appending any custom-field matches that
		// didn't appear in the name filter.
		const customFieldIds = new Set(
			customFieldMatches.map((c) => c._id as Id<"contacts">),
		);
		const seen = new Set<string>(nameMatches.map((c) => c._id as string));
		const extra = contacts.filter(
			(c) => customFieldIds.has(c._id) && !seen.has(c._id as string),
		);
		return [...nameMatches, ...extra];
	}, [contacts, searchQuery, customFieldMatches]);

	if (contacts === undefined) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
			</div>
		);
	}

	if (contacts.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center p-6 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
					<Users className="h-6 w-6 text-primary/50" />
				</div>
				<p className="mt-4 font-display font-medium text-muted-foreground text-sm">
					No contacts yet
				</p>
				<p className="mt-1 text-muted-foreground/60 text-xs">
					Create a contact from a chat to get started
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col bg-sidebar">
			<div className="space-y-2 p-3">
				<div className="relative flex-1">
					<Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						aria-label="Search contacts"
						className="h-8 border-transparent bg-muted/60 pl-8 text-[13px] placeholder:text-muted-foreground/50 focus:border-border focus:bg-background"
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search contacts..."
						type="search"
						value={searchQuery}
					/>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto px-1.5 pb-2">
				{filteredContacts.length === 0 ? (
					<div className="p-4 text-center text-muted-foreground text-xs">
						No contacts found
					</div>
				) : (
					<div className="space-y-px">
						{filteredContacts.map((contact) => {
							const isSelected = selectedContactId === contact._id;
							const displayName = contact.displayName;
							const preview =
								contact.lastMessagePreview ??
								(contact.lastMessageChatDisplayName
									? `Last: ${contact.lastMessageChatDisplayName}`
									: undefined);

							return (
								<button
									className={cn(
										"group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all",
										isSelected ? "bg-accent/80" : "hover:bg-muted/40",
									)}
									key={contact._id}
									onClick={() => onSelectContact(contact._id)}
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
											{getInitials(displayName)}
										</div>
									</div>

									<div className="min-w-0 flex-1">
										<div className="flex items-center justify-between gap-2">
											<div className="flex min-w-0 items-center gap-1.5">
												<span className="truncate font-medium text-[13px]">
													{displayName}
												</span>
												{contact.linkedChatCount > 0 && (
													<Badge
														className="h-4 px-1.5 text-[10px]"
														variant="secondary"
													>
														{contact.linkedChatCount}
													</Badge>
												)}
											</div>
											{contact.lastInteractionAt && (
												<span className="shrink-0 text-[11px] text-muted-foreground/70">
													{formatTimestamp(contact.lastInteractionAt)}
												</span>
											)}
										</div>

										{preview && (
											<div className="mt-px flex items-center gap-1.5">
												<p className="min-w-0 flex-1 truncate text-muted-foreground/70 text-xs">
													{preview}
												</p>
											</div>
										)}
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
