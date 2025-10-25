import { ArrowLeft, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { suggestDisplayName } from "../lib/utils";
import { updateChatPin } from "../services/chat-service";
import type { Chat } from "../types";

type AddChatDialogProps = {
	chats: Chat[];
	selectedIds: Set<string>;
	onAdd: (chat: Chat, name: string) => void;
	onClose: () => void;
};

export function AddChatDialog({
	chats,
	selectedIds,
	onAdd,
	onClose,
}: AddChatDialogProps) {
	const [query, setQuery] = useState("");
	const [toAdd, setToAdd] = useState<Chat | null>(null);
	const [tempName, setTempName] = useState("");

	const q = query.trim().toLowerCase();
	const filtered = (
		q
			? chats.filter((c) => {
					const hay = [
						c.id,
						c.username ? `@${c.username}` : "",
						suggestDisplayName(c),
						c.phone ?? "",
					]
						.join(" ")
						.toLowerCase();
					return hay.includes(q);
				})
			: chats.slice()
	)
		.toSorted((a, b) =>
			suggestDisplayName(a).localeCompare(suggestDisplayName(b))
		)
		.toSorted(
			(a, b) => Number(selectedIds.has(a.id)) - Number(selectedIds.has(b.id))
		)
		.slice(0, 100);

	async function addSelected(chat: Chat, name: string) {
		await updateChatPin(chat.id, true, name);
		onAdd(chat, name);
		setToAdd(null);
		setTempName("");
		setQuery("");
	}

	return (
		<section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
			{toAdd ? (
				<>
					<div className="space-y-2">
						<div className="text-muted-foreground text-sm">
							Selected contact
						</div>
						<div className="rounded-md border bg-background p-3">
							<div className="font-medium">{suggestDisplayName(toAdd)}</div>
							<div className="text-muted-foreground text-xs">
								{toAdd.username ? `@${toAdd.username} · ` : ""}
								{toAdd.phone ? `${toAdd.phone} · ` : ""}
								{toAdd.id}
							</div>
						</div>
					</div>

					<div className="space-y-2">
						<label className="font-medium text-sm" htmlFor="display-name">
							Display name
						</label>
						<Input
							id="display-name"
							onChange={(e) => setTempName(e.currentTarget.value)}
							placeholder="Enter a display name"
							value={tempName}
						/>
						<p className="text-muted-foreground text-xs">
							Suggested based on the chat details. You can customize it before
							adding.
						</p>
					</div>

					<div className="flex gap-2">
						<Button
							onClick={() =>
								addSelected(toAdd, tempName.trim() || suggestDisplayName(toAdd))
							}
							type="button"
						>
							<Plus className="h-4 w-4" />
						</Button>
						<Button
							onClick={() => {
								setToAdd(null);
								setTempName("");
							}}
							type="button"
							variant="outline"
						>
							<ArrowLeft className="h-4 w-4" />
						</Button>
					</div>
				</>
			) : (
				<>
					<div className="space-y-2">
						<label className="font-medium text-sm" htmlFor="search-contact">
							Find a contact
						</label>
						<Input
							id="search-contact"
							onChange={(e) => setQuery(e.currentTarget.value)}
							placeholder="Search by username, name, or phone…"
							value={query}
						/>
					</div>

					<div className="max-h-64 overflow-auto rounded-md border">
						{filtered.length === 0 ? (
							<div className="p-3 text-muted-foreground text-sm">
								No results
							</div>
						) : (
							filtered.map((c) => {
								const already = selectedIds.has(c.id);
								return (
									<button
										className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
										disabled={already}
										key={c.id}
										onClick={() => {
											setToAdd(c);
											setTempName(suggestDisplayName(c));
										}}
										type="button"
									>
										<div className="min-w-0">
											<div className="truncate font-medium">
												{suggestDisplayName(c)}
											</div>
											<div className="truncate text-muted-foreground text-xs">
												{c.username ? `@${c.username} · ` : ""}
												{c.phone ? `${c.phone} · ` : ""}
												{c.id}
											</div>
										</div>
										{already ? (
											<span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground text-xs">
												Added
											</span>
										) : null}
									</button>
								);
							})
						)}
					</div>

					<div className="flex justify-end gap-2">
						<Button onClick={onClose} type="button" variant="outline">
							<X className="h-4 w-4" />
						</Button>
					</div>
				</>
			)}
		</section>
	);
}
