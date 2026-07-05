import type { Id } from "@/lib/convex";

export type FactKind = "note" | "knowledge" | "task" | "link" | "date";
export type FactPriority = "low" | "normal" | "high" | "critical";

export interface FactRow {
	_id: Id<"contactFacts">;
	kind: FactKind;
	title: string;
	body?: string;
	priority: FactPriority;
	pinned: boolean;
	occurredAt: number;
	dueAt?: number;
}

export function formatFactDay(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString([], {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function priorityRank(priority: FactPriority): number {
	switch (priority) {
		case "critical":
			return 4;
		case "high":
			return 3;
		case "normal":
			return 2;
		case "low":
			return 1;
	}
}
