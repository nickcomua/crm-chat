import { surrealql } from "@surrealdb/surrealdb";
import { ArrowLeft, Edit, Plus, X } from "lucide-react";
import { useId, useState } from "react";
// import { commands, type Chat } from "./bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChatView } from "./chat";
import { useLiveQuery } from "./contexts/surreal-provider";
import { updateChatName, updateChatPin } from "./services/chat-service";

const CHAT_ID_PREFIX_LENGTH = 6;
const MAX_SEARCH_RESULTS = 100;

function getFullName(c: Chat): string {
	return [c.first_name ?? "", c.last_name ?? ""].join(" ").trim();
}

function chatLabel(c: Chat): string {
	const full = getFullName(c);
	if (full) {
		return full;
	}
	if (c.username) {
		return `@${c.username}`;
	}
	if (c.phone) {
		return c.phone!;
	}
	return c.id;
}

function suggestDisplayName(c: Chat): string {
	if (c.username) {
		return `@${c.username}`;
	}
	const full = getFullName(c);
	if (full) {
		return full;
	}
	if (c.phone) {
		return c.phone!;
	}
	return `Chat ${c.id.slice(0, CHAT_ID_PREFIX_LENGTH)}`;
}

export type Chat = {
	id: string;
	username: string | null;
	first_name: string | null;
	is_pinned: boolean;
	pined_name: string | null;
	last_name: string | null;
	phone: string | null;
};

export function App() {
	// const [chats, setChats] = useState<Chat[]>([]);query
	const { data: chatsDict } = useLiveQuery<Chat>({
		query: surrealql`SELECT type::string(id) as id, content[0].Telegram.User.User.username as username, content[0].Telegram.User.User.first_name as first_name, content[0].Telegram.User.User.last_name as last_name, content[0].Telegram.User.User.phone as phone , is_pinned, pined_name FROM chat`,
		liveQuery: surrealql`LIVE SELECT type::string(id) as id, content[0].Telegram.User.User.username as username, content[0].Telegram.User.User.first_name as first_name, content[0].Telegram.User.User.last_name as last_name, content[0].Telegram.User.User.phone as phone , is_pinned, pined_name FROM chat`,
		queryKey: ["live", "chats"],
	});
	// console.log('chatsDict', chatsDict)
	const chats = Object.values(chatsDict ?? {}).map((c) => c!);
	const [openChat, setOpenChat] = useState<string | null>(null);
	const selected = chats.flatMap((s) =>
		s.is_pinned
			? [
					{
						id: s.id,
						name: s.pined_name ?? s.username ?? getFullName(s),
					},
				]
			: []
	);
	const [addOpen, setAddOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [toAdd, setToAdd] = useState<Chat | null>(null);
	const [tempName, setTempName] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const searchId = useId();
	const displayId = useId();

	const q = query.trim().toLowerCase();
	const inSelected = new Set(selected.map((s) => s.id));
	const filtered = (
		q
			? chats.filter((c) => {
					const hay = [
						c.id,
						c.username ? `@${c.username}` : "",
						getFullName(c),
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
			(a, b) => Number(inSelected.has(a.id)) - Number(inSelected.has(b.id))
		)
		.slice(0, MAX_SEARCH_RESULTS);

	async function addSelected(chat: Chat, name: string) {
		await updateChatPin(chat.id, true, name);
		setAddOpen(false);
		setToAdd(null);
		setQuery("");
		setTempName("");
	}

	async function removeSelected(id: string) {
		await updateChatPin(id, false);
		if (editingId === id) {
			setEditingId(null);
			setRenameValue("");
		}
	}

	function beginRename(id: string, name: string) {
		setEditingId(id);
		setRenameValue(name);
	}

	async function commitRename() {
		if (!editingId) {
			return;
		}
		await updateChatName(editingId, renameValue.trim());
		setEditingId(null);
		setRenameValue("");
	}

	if (openChat) {
		const chat = chatsDict?.[openChat];
		if (!chat) {
			return (
				<main className="mx-auto max-w-3xl space-y-6 p-6">
					<header className="flex items-center justify-between">
						<Button
							onClick={() => setOpenChat(null)}
							type="button"
							variant="outline"
						>
							<ArrowLeft className="h-4 w-4" />
						</Button>
						<div className="text-muted-foreground text-sm">Loading chat…</div>
					</header>
				</main>
			);
		}
		return <ChatView chat={chat} close={() => setOpenChat(null)} />;
	}

	return (
		<main className="mx-auto max-w-3xl space-y-6 p-6">
			<header className="flex items-center justify-between">
				<h1 className="font-semibold text-2xl">Selected contacts</h1>
				<Button
					onClick={() => {
						setAddOpen((v) => !v);
						setToAdd(null);
						setQuery("");
						setTempName("");
					}}
					type="button"
				>
					<Plus className="h-4 w-4" />
				</Button>
			</header>

			<section className="rounded-lg border bg-card p-4 shadow-sm">
				{selected.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No contacts selected yet. Click “Add contact” to begin.
					</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{selected.map((s) => {
							const isEditing = editingId === s.id;
							return (
								<div
									className="group inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1 shadow-xs"
									key={s.id}
								>
									{isEditing ? (
										<Input
											autoFocus
											className="h-7 w-40"
											onBlur={commitRename}
											onChange={(e) => setRenameValue(e.currentTarget.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													commitRename();
												}
												if (e.key === "Escape") {
													setEditingId(null);
													setRenameValue("");
												}
											}}
											value={renameValue}
										/>
									) : (
										<button
											className="font-medium"
											onClick={() => {
												setOpenChat(s.id);
											}}
											type="button"
										>
											{s.name}
										</button>
									)}
									<div className="flex items-center gap-1">
										{isEditing ? null : (
											<Button
												onClick={() => beginRename(s.id, s.name)}
												size="icon-sm"
												title="Rename"
												type="button"
												variant="ghost"
											>
												<Edit className="h-3 w-3" />
											</Button>
										)}
										<Button
											onClick={() => removeSelected(s.id)}
											size="icon-sm"
											title="Remove"
											type="button"
											variant="ghost"
										>
											<X className="h-3 w-3" />
										</Button>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</section>

			{addOpen && (
				<section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
					{toAdd ? (
						<>
							<div className="space-y-2">
								<div className="text-muted-foreground text-sm">
									Selected contact
								</div>
								<div className="rounded-md border bg-background p-3">
									<div className="font-medium">{chatLabel(toAdd)}</div>
									<div className="text-muted-foreground text-xs">
										{toAdd.username ? `@${toAdd.username} · ` : ""}
										{toAdd.phone ? `${toAdd.phone} · ` : ""}
										{toAdd.id}
									</div>
								</div>
							</div>

							<div className="space-y-2">
								<label className="font-medium text-sm" htmlFor={displayId}>
									Display name
								</label>
								<Input
									id={displayId}
									onChange={(e) => setTempName(e.currentTarget.value)}
									placeholder="Enter a display name"
									value={tempName}
								/>
								<p className="text-muted-foreground text-xs">
									Suggested based on the chat details. You can customize it
									before adding.
								</p>
							</div>

							<div className="flex gap-2">
								<Button
									onClick={() => {
										if (!toAdd) {
											return;
										}
										addSelected(
											toAdd,
											tempName.trim() || suggestDisplayName(toAdd)
										);
									}}
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
								<label className="font-medium text-sm" htmlFor={searchId}>
									Find a contact
								</label>
								<Input
									id={searchId}
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
										const already = selected.some((s) => s.id === c.id);
										return (
											<button
												className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
												disabled={false}
												key={c.id}
												onClick={() => {
													setToAdd(c);
													setTempName(suggestDisplayName(c));
												}}
												type="button"
											>
												<div className="min-w-0">
													<div className="truncate font-medium">
														{chatLabel(c)}
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
								<Button
									onClick={() => {
										setAddOpen(false);
										setToAdd(null);
									}}
									type="button"
									variant="outline"
								>
									<X className="h-4 w-4" />
								</Button>
							</div>
						</>
					)}
				</section>
			)}
		</main>
	);
}
