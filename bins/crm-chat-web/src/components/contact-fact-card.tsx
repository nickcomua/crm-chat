import { Pin, Trash2 } from "lucide-react";
import { type FactRow, formatFactDay } from "./contact-fact-model";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export function ContactFactCard({
	fact,
	onDelete,
}: {
	fact: FactRow;
	onDelete: () => void;
}): React.ReactNode {
	return (
		<div className="rounded-lg border border-border/50 bg-card/50 p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="mb-1 flex flex-wrap items-center gap-1">
						<Badge className="h-5 text-[10px]" variant="secondary">
							{fact.kind}
						</Badge>
						<Badge className="h-5 text-[10px]" variant="outline">
							{fact.priority}
						</Badge>
						{fact.pinned && <Pin className="h-3 w-3 text-primary" />}
					</div>
					<p className="font-medium text-sm">{fact.title}</p>
					{fact.body && (
						<p className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs">
							{fact.body}
						</p>
					)}
					<p className="mt-2 text-muted-foreground/70 text-[11px]">
						{formatFactDay(fact.occurredAt)}
						{fact.dueAt ? ` · due ${formatFactDay(fact.dueAt)}` : ""}
					</p>
				</div>
				<Button
					aria-label="Delete fact"
					className="h-7 w-7 shrink-0"
					onClick={onDelete}
					size="icon"
					variant="ghost"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</Button>
			</div>
		</div>
	);
}
