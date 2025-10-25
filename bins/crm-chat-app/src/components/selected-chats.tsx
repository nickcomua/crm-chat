import { Edit, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateChatName } from "../services/chat-service";

type SelectedChatsProps = {
	selected: { id: string; name: string }[];
	onOpenChat: (id: string) => void;
	onRemove: (id: string) => void;
};

export function SelectedChats({
	selected,
	onOpenChat,
	onRemove,
}: SelectedChatsProps) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	function beginRename(id: string, name: string) {
		setEditingId(id);
		setRenameValue(name);
	}

	async function commitRename() {
		if (!(editingId && renameValue.trim())) {
			return;
		}
		await updateChatName(editingId, renameValue.trim());
		setEditingId(null);
		setRenameValue("");
	}

	return (
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
										onClick={() => onOpenChat(s.id)}
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
										onClick={() => onRemove(s.id)}
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
	);
}
