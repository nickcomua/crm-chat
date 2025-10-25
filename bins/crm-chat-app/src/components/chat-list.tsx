import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { chatLabel } from "../lib/utils";
import type { Chat } from "../types";

const MAX_RESULTS = 100;

type ChatListProps = {
	chats: Chat[];
	selectedIds: Set<string>;
	onSelectChat: (chat: Chat) => void;
	onClose: () => void;
};

export function ChatList({
	chats,
	selectedIds,
	onSelectChat,
	onClose,
}: ChatListProps) {
	const [query, setQuery] = useState("");

	const q = query.trim().toLowerCase();
	const filtered = (
		q
			? chats.filter((c) => {
					const hay = [
						c.id,
						c.username ? `@${c.username}` : "",
						chatLabel(c),
						c.phone ?? "",
					]
						.join(" ")
						.toLowerCase();
					return hay.includes(q);
				})
			: chats.slice()
	)
		.toSorted((a, b) => chatLabel(a).localeCompare(chatLabel(b)))
		.toSorted(
			(a, b) => Number(selectedIds.has(a.id)) - Number(selectedIds.has(b.id))
		)
		.slice(0, MAX_RESULTS);

	return (
		<section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
			<div className="space-y-2">
				<label className="font-medium text-sm" htmlFor="search-chat">
					Find a contact
				</label>
				<Input
					id="search-chat"
					onChange={(e) => setQuery(e.currentTarget.value)}
					placeholder="Search by username, name, or phone…"
					value={query}
				/>
			</div>

			<div className="max-h-64 overflow-auto rounded-md border">
				{filtered.length === 0 ? (
					<div className="p-3 text-muted-foreground text-sm">No results</div>
				) : (
					filtered.map((c) => {
						const already = selectedIds.has(c.id);
						return (
							<button
								className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
								disabled={already}
								key={c.id}
								onClick={() => onSelectChat(c)}
								type="button"
							>
								<div className="min-w-0">
									<div className="truncate font-medium">{chatLabel(c)}</div>
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
					<ArrowLeft className="h-4 w-4" />
				</Button>
			</div>
		</section>
	);
}
