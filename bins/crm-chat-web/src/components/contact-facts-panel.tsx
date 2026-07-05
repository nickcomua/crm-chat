import { useMutation, useQuery } from "convex/react";
import { CalendarDays, Flag, List, Pin, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type Id, onResultError } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { ContactFactCard } from "./contact-fact-card";
import {
	type FactKind,
	type FactPriority,
	type FactRow,
	formatFactDay,
	priorityRank,
} from "./contact-fact-model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

const KIND_OPTIONS: readonly FactKind[] = [
	"note",
	"knowledge",
	"task",
	"link",
	"date",
];
const PRIORITY_OPTIONS: readonly FactPriority[] = [
	"low",
	"normal",
	"high",
	"critical",
];

function renderFacts(
	items: readonly FactRow[],
	onDelete: (factId: Id<"contactFacts">) => void,
): React.ReactNode {
	return items.length === 0 ? (
		<p className="py-3 text-muted-foreground/70 text-xs">No facts yet.</p>
	) : (
		<div className="space-y-2">
			{items.map((fact) => (
				<ContactFactCard
					fact={fact}
					key={fact._id}
					onDelete={() => onDelete(fact._id)}
				/>
			))}
		</div>
	);
}

export function ContactFactsPanel({
	contactId,
}: {
	contactId: Id<"contacts">;
}): React.ReactNode {
	const facts =
		useQuery(api.model.contactFacts.listForContact, {
			contactId,
		}) ?? [];
	const createFact = useMutation(api.model.contactFacts.create);
	const removeFact = useMutation(api.model.contactFacts.remove);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [kind, setKind] = useState<FactKind>("note");
	const [priority, setPriority] = useState<FactPriority>("normal");
	const [pinned, setPinned] = useState(false);

	const pinnedFacts = facts.filter((fact) => fact.pinned);
	const chronologicalFacts = [...facts].sort(
		(left, right) => right.occurredAt - left.occurredAt,
	);
	const priorityFacts = [...facts].sort(
		(left, right) =>
			priorityRank(right.priority) - priorityRank(left.priority) ||
			right.occurredAt - left.occurredAt,
	);
	const calendarGroups = useMemo(() => {
		const groups = new Map<string, FactRow[]>();
		for (const fact of chronologicalFacts) {
			const key = new Date(fact.dueAt ?? fact.occurredAt)
				.toISOString()
				.slice(0, 10);
			groups.set(key, [...(groups.get(key) ?? []), fact]);
		}
		return [...groups.entries()];
	}, [chronologicalFacts]);

	const handleCreate = (): void => {
		const trimmed = title.trim();
		if (!trimmed) {
			return;
		}
		createFact({
			contactId,
			fact: {
				kind,
				title: trimmed,
				body: body.trim() || undefined,
				priority,
				pinned,
			},
		}).then((result) => {
			onResultError(result);
			setTitle("");
			setBody("");
			setPinned(false);
		});
	};
	const handleDelete = (factId: Id<"contactFacts">): void => {
		removeFact({ factId }).then(onResultError);
	};

	return (
		<section className="space-y-4">
			<div className="space-y-2">
				<div className="grid gap-2">
					<Label htmlFor="fact-title">New fact</Label>
					<Input
						id="fact-title"
						onChange={(event) => setTitle(event.target.value)}
						placeholder="What should be remembered?"
						value={title}
					/>
					<Textarea
						className="min-h-16 resize-none"
						onChange={(event) => setBody(event.target.value)}
						placeholder="Optional details"
						value={body}
					/>
				</div>
				<div className="flex flex-wrap gap-1">
					{KIND_OPTIONS.map((option) => (
						<Button
							className="h-7 px-2 text-xs"
							key={option}
							onClick={() => setKind(option)}
							type="button"
							variant={kind === option ? "default" : "outline"}
						>
							{option}
						</Button>
					))}
				</div>
				<div className="flex flex-wrap items-center gap-1">
					{PRIORITY_OPTIONS.map((option) => (
						<Button
							className="h-7 px-2 text-xs"
							key={option}
							onClick={() => setPriority(option)}
							type="button"
							variant={priority === option ? "default" : "outline"}
						>
							{option}
						</Button>
					))}
					<Button
						className={cn("h-7 px-2 text-xs", pinned && "text-primary")}
						onClick={() => setPinned((value) => !value)}
						type="button"
						variant="outline"
					>
						<Pin className="mr-1 h-3 w-3" />
						Pin
					</Button>
					<Button className="h-7 px-2 text-xs" onClick={handleCreate}>
						<Plus className="mr-1 h-3 w-3" />
						Add
					</Button>
				</div>
			</div>

			<Tabs defaultValue="pinned">
				<TabsList className="h-8">
					<TabsTrigger className="text-xs" value="pinned">
						<Pin className="mr-1 h-3 w-3" />
						Pinned
					</TabsTrigger>
					<TabsTrigger className="text-xs" value="timeline">
						<List className="mr-1 h-3 w-3" />
						List
					</TabsTrigger>
					<TabsTrigger className="text-xs" value="priority">
						<Flag className="mr-1 h-3 w-3" />
						Priority
					</TabsTrigger>
					<TabsTrigger className="text-xs" value="calendar">
						<CalendarDays className="mr-1 h-3 w-3" />
						Calendar
					</TabsTrigger>
				</TabsList>
				<TabsContent value="pinned">
					{renderFacts(pinnedFacts, handleDelete)}
				</TabsContent>
				<TabsContent value="timeline">
					{renderFacts(chronologicalFacts, handleDelete)}
				</TabsContent>
				<TabsContent value="priority">
					{renderFacts(priorityFacts, handleDelete)}
				</TabsContent>
				<TabsContent value="calendar">
					{calendarGroups.length === 0 ? (
						<p className="py-3 text-muted-foreground/70 text-xs">
							No dated facts yet.
						</p>
					) : (
						<div className="space-y-3">
							{calendarGroups.map(([day, items]) => (
								<div key={day}>
									<p className="mb-1 font-medium text-muted-foreground text-xs">
										{formatFactDay(new Date(day).getTime())}
									</p>
									{renderFacts(items, handleDelete)}
								</div>
							))}
						</div>
					)}
				</TabsContent>
			</Tabs>
		</section>
	);
}
