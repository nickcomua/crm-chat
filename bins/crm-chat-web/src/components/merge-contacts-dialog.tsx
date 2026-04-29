import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Id, onResultError } from "@/lib/convex";
import { Button } from "./ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "./ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type ConflictResolution = "keepTarget" | "keepSource" | "keepBoth";

interface MergeContactsDialogProps {
	sourceContactId: Id<"contacts">;
	sourceDisplayName: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

interface ContactListRow {
	_id: Id<"contacts">;
	displayName: string;
	linkedChatCount: number;
	linkedSenderCount: number;
	customFields: Array<{ key: string; value: string }>;
}

const RESOLUTION_LABELS: Record<ConflictResolution, string> = {
	keepTarget: "Keep target's fields",
	keepSource: "Use source's fields",
	keepBoth: "Keep both (append)",
};

export function MergeContactsDialog({
	sourceContactId,
	sourceDisplayName,
	onOpenChange,
	open,
}: MergeContactsDialogProps): React.ReactNode {
	const navigate = useNavigate();
	const mergeContacts = useMutation(api.model.contacts.mergeContacts);

	const contacts = useQuery(api.model.contacts.list) as
		| ContactListRow[]
		| undefined;

	const [search, setSearch] = useState("");
	const [targetId, setTargetId] = useState<Id<"contacts"> | null>(null);
	const [resolution, setResolution] = useState<ConflictResolution>("keepBoth");

	useEffect(() => {
		if (open) {
			setSearch("");
			setTargetId(null);
			setResolution("keepBoth");
		}
	}, [open]);

	const source = useMemo(
		() => contacts?.find((c) => c._id === sourceContactId),
		[contacts, sourceContactId],
	);
	const target = useMemo(
		() => contacts?.find((c) => c._id === targetId),
		[contacts, targetId],
	);

	const filteredContacts = useMemo(() => {
		if (!contacts) {
			return [];
		}
		const q = search.trim().toLowerCase();
		return contacts
			.filter((c) => c._id !== sourceContactId)
			.filter((c) => q.length === 0 || c.displayName.toLowerCase().includes(q));
	}, [contacts, search, sourceContactId]);

	const submit = (): void => {
		if (!targetId) {
			return;
		}
		mergeContacts({
			sourceId: sourceContactId,
			targetId,
			conflictResolution: resolution,
		}).then((res) => {
			onResultError(res);
			if (res && typeof res === "object" && "Ok" in res) {
				const ok = res.Ok as { mergedContactId: Id<"contacts"> };
				onOpenChange(false);
				navigate({
					to: "/contacts/$contactId",
					params: { contactId: ok.mergedContactId },
				});
			}
		});
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Merge contacts</DialogTitle>
					<DialogDescription>
						Move all links, pins, and notes from the source contact into the
						target.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div className="space-y-1">
						<p className="font-medium text-xs">Source</p>
						<div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
							{sourceDisplayName}
							{source && (
								<span className="ml-2 text-muted-foreground text-xs">
									· {source.linkedChatCount} chats ·{" "}
									{source.customFields.length} custom fields
								</span>
							)}
						</div>
					</div>

					<div className="space-y-1">
						<p className="font-medium text-xs">Target</p>
						<div className="rounded-md border border-border/60">
							<Command>
								<CommandInput
									onValueChange={setSearch}
									placeholder="Search target contact…"
									value={search}
								/>
								<CommandList className="max-h-48">
									<CommandEmpty>No contacts found.</CommandEmpty>
									<CommandGroup>
										{filteredContacts.map((c) => (
											<CommandItem
												key={c._id}
												onSelect={() => setTargetId(c._id)}
												value={c.displayName}
											>
												<div className="flex w-full items-center justify-between gap-2">
													<span
														className={
															targetId === c._id ? "font-medium" : undefined
														}
													>
														{c.displayName}
													</span>
													<span className="text-[10px] text-muted-foreground">
														{c.linkedChatCount} chats
													</span>
												</div>
											</CommandItem>
										))}
									</CommandGroup>
								</CommandList>
							</Command>
						</div>
					</div>

					<div className="space-y-1">
						<p className="font-medium text-xs">Custom field conflicts</p>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									className="w-full justify-between"
									size="sm"
									variant="outline"
								>
									{RESOLUTION_LABELS[resolution]}
									<ChevronDown className="h-3 w-3" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-72" align="start">
								{(Object.keys(RESOLUTION_LABELS) as ConflictResolution[]).map(
									(r) => (
										<DropdownMenuItem key={r} onClick={() => setResolution(r)}>
											{RESOLUTION_LABELS[r]}
										</DropdownMenuItem>
									),
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					{source && target && (
						<div className="rounded-md border border-border/40 bg-muted/20 p-2.5 text-xs">
							<p className="font-medium">Will move:</p>
							<ul className="mt-1 space-y-0.5 text-muted-foreground">
								<li>
									~{source.linkedSenderCount} sender link
									{source.linkedSenderCount === 1 ? "" : "s"}
								</li>
								<li>
									~{source.customFields.length} custom field
									{source.customFields.length === 1 ? "" : "s"}
								</li>
								<li>and any pinned messages on the source contact</li>
							</ul>
							<p className="mt-1 text-muted-foreground">
								Source contact &ldquo;{sourceDisplayName}&rdquo; will be
								deleted.
							</p>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button disabled={!targetId} onClick={submit}>
						Merge into target
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
