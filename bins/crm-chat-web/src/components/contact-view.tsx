import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import {
	ArrowLeft,
	Check,
	LayoutGrid,
	Link2Off,
	MoreVertical,
	PencilLine,
	Trash2,
	Users,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Id, onResultError } from "@/lib/convex";
import { cn, getAvatarGradient, getInitials } from "../lib/utils";
import { ContactInformationPanel } from "./contact-information-panel";
import { ContactMergedTimeline } from "./contact-merged-timeline";
import { ContactPinnedMessages } from "./contact-pinned-messages";
import { MergeContactsDialog } from "./merge-contacts-dialog";
import { MessageList } from "./message-list";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "./ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface ContactViewProps {
	contactId: Id<"contacts">;
	onBack?: () => void;
}

interface ContactLinkRow {
	_id: Id<"chatContactLinks">;
	chatId: string;
	senderId: string;
	createdAt: number;
}

const MERGED_TAB_VALUE = "merged";

function tabValueFor(link: ContactLinkRow): string {
	return `${link.chatId}:${link.senderId}`;
}

export function ContactView({
	contactId,
	onBack,
}: ContactViewProps): React.ReactNode {
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as {
		dialogId?: string;
		pinnedMessageId?: string;
	};

	const contactData = useQuery(api.model.contacts.get, { contactId });
	const chats = useQuery(api.model.chats.list) as
		| Array<{
				chatId: string;
				chatType: "Dialog" | "Group";
				pinnedName?: string;
		  }>
		| undefined;

	const updateContact = useMutation(api.model.contacts.update);
	const deleteContact = useMutation(api.model.contacts.deleteContact);
	const unlinkSender = useMutation(api.model.contacts.unlinkSender);

	const [isEditingName, setIsEditingName] = useState(false);
	const [editName, setEditName] = useState("");
	const [sheetOpen, setSheetOpen] = useState(false);
	const [mergeDialogOpen, setMergeDialogOpen] = useState(false);

	const contact = contactData?.contact;
	const links = contactData?.links ?? [];

	// Sync local edit state when contact changes.
	useEffect(() => {
		if (contact) {
			setEditName(contact.displayName);
		}
	}, [contact]);

	if (contactData === undefined || chats === undefined) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
			</div>
		);
	}

	if (contactData === null || !contact) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center">
				<div>
					<p className="text-muted-foreground text-sm">Contact not found.</p>
					<Button
						className="mt-3"
						onClick={() => navigate({ to: "/contacts" })}
						variant="outline"
					>
						Back to contacts
					</Button>
				</div>
			</div>
		);
	}

	const chatsByChatId = new Map(chats.map((c) => [c.chatId, c]));

	const selectedTab =
		typeof search.dialogId === "string" && search.dialogId.length > 0
			? search.dialogId
			: MERGED_TAB_VALUE;

	const handleTabChange = (value: string): void => {
		navigate({
			to: "/contacts/$contactId",
			params: { contactId },
			search: {
				dialogId: value === MERGED_TAB_VALUE ? undefined : value,
				pinnedMessageId: undefined,
			},
		});
	};

	const handleSaveName = (): void => {
		const trimmed = editName.trim();
		if (trimmed.length === 0 || trimmed === contact.displayName) {
			setIsEditingName(false);
			setEditName(contact.displayName);
			return;
		}
		updateContact({ contactId, displayName: trimmed }).then(onResultError);
		setIsEditingName(false);
	};

	const handleDelete = (): void => {
		deleteContact({ contactId }).then((res) => {
			onResultError(res);
			navigate({ to: "/contacts" });
		});
	};

	const handleUnlink = (link: ContactLinkRow): void => {
		unlinkSender({
			contactId,
			chatId: link.chatId,
			senderId: link.senderId,
		}).then(onResultError);
	};

	const displayName = contact.displayName;
	const isOnline = contactData.isOnline;
	const linkedChatCount = new Set(links.map((l) => l.chatId)).size;

	// Resolve the targetMessageId for scroll-highlight in the selected tab.
	const targetMessageId = search.pinnedMessageId;

	return (
		<div className="flex h-full flex-col">
			{/* Header */}
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

				<div className="relative shrink-0">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-full font-medium text-white text-sm shadow-sm"
						style={{ background: getAvatarGradient(displayName) }}
					>
						{getInitials(displayName)}
					</div>
					{isOnline && (
						<>
							<span
								aria-hidden="true"
								className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border-2 border-background bg-emerald-500 shadow-sm"
							/>
							<span className="sr-only">{displayName} is online</span>
						</>
					)}
				</div>

				<div className="min-w-0 flex-1">
					{isEditingName ? (
						<div className="flex items-center gap-2">
							<Input
								autoFocus
								className="h-7 text-sm"
								onChange={(e) => setEditName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										handleSaveName();
									} else if (e.key === "Escape") {
										setIsEditingName(false);
										setEditName(contact.displayName);
									}
								}}
								value={editName}
							/>
							<Button
								aria-label="Save name"
								className="h-7 w-7"
								onClick={handleSaveName}
								size="icon"
								variant="ghost"
							>
								<Check className="h-3.5 w-3.5" />
							</Button>
							<Button
								aria-label="Cancel"
								className="h-7 w-7"
								onClick={() => {
									setIsEditingName(false);
									setEditName(contact.displayName);
								}}
								size="icon"
								variant="ghost"
							>
								<X className="h-3.5 w-3.5" />
							</Button>
						</div>
					) : (
						<button
							className="group flex items-center gap-1.5 text-left"
							onClick={() => setIsEditingName(true)}
							title="Click to edit name"
							type="button"
						>
							<h2 className="truncate font-display font-semibold text-sm">
								{displayName}
							</h2>
							<PencilLine className="h-3 w-3 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
						</button>
					)}
					<p className="truncate text-muted-foreground/70 text-xs">
						{links.length} sender{links.length === 1 ? "" : "s"} •{" "}
						{linkedChatCount} chat{linkedChatCount === 1 ? "" : "s"}
					</p>
				</div>

				<Sheet onOpenChange={setSheetOpen} open={sheetOpen}>
					<SheetTrigger asChild>
						<Button
							aria-label="Contact details"
							className="h-8 w-8"
							size="icon"
							variant="ghost"
						>
							<LayoutGrid className="h-3.5 w-3.5" />
						</Button>
					</SheetTrigger>
					<SheetContent className="w-full sm:max-w-md" side="right">
						<SheetHeader>
							<SheetTitle>Contact details</SheetTitle>
						</SheetHeader>
						<div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
							<ContactInformationPanel contactId={contactId} />
							<Separator />
							<ContactPinnedMessages contactId={contactId} />
						</div>
					</SheetContent>
				</Sheet>

				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							aria-label="Contact actions"
							className="h-8 w-8"
							size="icon"
							variant="ghost"
						>
							<MoreVertical className="h-3.5 w-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => setIsEditingName(true)}>
							<PencilLine className="mr-2 h-3.5 w-3.5" />
							Edit name
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setMergeDialogOpen(true)}>
							<Users className="mr-2 h-3.5 w-3.5" />
							Merge with…
						</DropdownMenuItem>
						{links.length > 0 && (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<Link2Off className="mr-2 h-3.5 w-3.5" />
									Unlink a sender
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									<DropdownMenuLabel>Linked senders</DropdownMenuLabel>
									{links.map((link) => {
										const chat = chatsByChatId.get(link.chatId);
										const label = chat?.pinnedName
											? chat.pinnedName
											: `Chat ${link.chatId.slice(0, 8)}`;
										return (
											<DropdownMenuItem
												key={link._id}
												onClick={() => handleUnlink(link)}
											>
												{label} · {link.senderId.slice(0, 12)}
											</DropdownMenuItem>
										);
									})}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={handleDelete} variant="destructive">
							<Trash2 className="mr-2 h-3.5 w-3.5" />
							Delete contact
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Tabs */}
			<Tabs
				className="flex-1"
				onValueChange={handleTabChange}
				value={selectedTab}
			>
				<div className="border-border/50 border-b px-4 py-2">
					<TabsList className="h-8">
						<TabsTrigger className="text-xs" value={MERGED_TAB_VALUE}>
							All dialogs
						</TabsTrigger>
						{links.map((link) => {
							const chat = chatsByChatId.get(link.chatId);
							const label = chat?.pinnedName
								? chat.pinnedName
								: `Chat ${link.chatId.slice(0, 8)}`;
							const isGroup = chat?.chatType === "Group";
							const value = tabValueFor(link);
							return (
								<TabsTrigger
									className={cn("text-xs")}
									key={link._id}
									value={value}
								>
									<span className="max-w-[10rem] truncate">{label}</span>
									{isGroup && (
										<Badge
											className="ml-1 h-4 px-1 text-[9px]"
											variant="secondary"
										>
											group
										</Badge>
									)}
								</TabsTrigger>
							);
						})}
					</TabsList>
				</div>

				<TabsContent
					className="flex-1 overflow-hidden"
					value={MERGED_TAB_VALUE}
				>
					<ContactMergedTimeline
						contactId={contactId}
						targetMessageId={targetMessageId}
					/>
				</TabsContent>

				{links.map((link) => {
					const value = tabValueFor(link);
					return (
						<TabsContent
							className="flex-1 overflow-hidden"
							key={link._id}
							value={value}
						>
							<MessageList
								chatId={link.chatId}
								targetMessageId={targetMessageId}
							/>
						</TabsContent>
					);
				})}
			</Tabs>

			<MergeContactsDialog
				onOpenChange={setMergeDialogOpen}
				open={mergeDialogOpen}
				sourceContactId={contactId}
				sourceDisplayName={contact.displayName}
			/>
		</div>
	);
}
