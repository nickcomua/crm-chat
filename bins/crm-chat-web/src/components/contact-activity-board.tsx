import { useQuery } from "convex/react";
import { Activity, Clock, MessageSquare } from "lucide-react";
import { api, type Id } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";

interface ContactActivityBoardProps {
	contactId: Id<"contacts">;
}

interface ActivityDay {
	day: string;
	incomingMessages: number;
	outgoingMessages: number;
	onlineEvents: number;
	approxOnlineMinutes: number;
}

function formatStatusTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function buildCalendarDays(days: readonly ActivityDay[]): ActivityDay[] {
	const byDay = new Map(days.map((day) => [day.day, day]));
	const today = new Date();
	const cells: ActivityDay[] = [];
	for (let index = 90; index >= 0; index -= 1) {
		const date = new Date(today);
		date.setDate(today.getDate() - index);
		const key = date.toISOString().slice(0, 10);
		cells.push(
			byDay.get(key) ?? {
				day: key,
				incomingMessages: 0,
				outgoingMessages: 0,
				onlineEvents: 0,
				approxOnlineMinutes: 0,
			},
		);
	}
	return cells;
}

function intensityClass(value: number): string {
	if (value >= 12) {
		return "bg-primary";
	}
	if (value >= 6) {
		return "bg-primary/70";
	}
	if (value >= 2) {
		return "bg-primary/40";
	}
	if (value >= 1) {
		return "bg-primary/20";
	}
	return "bg-muted";
}

export function ContactActivityBoard({
	contactId,
}: ContactActivityBoardProps): React.ReactNode {
	const activity = useQuery(api.model.contactActivity.summaryForContact, {
		contactId,
		days: 91,
	});
	const statuses = useQuery(api.model.contactPresence.listForContact, {
		contactId,
		limit: 80,
	});

	const calendarDays = buildCalendarDays(activity?.days ?? []);
	const latestStatuses = statuses?.slice(0, 10) ?? [];

	return (
		<section className="space-y-3">
			<div className="grid grid-cols-3 gap-2">
				<div className="rounded-lg border border-border/50 p-2">
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<MessageSquare className="h-3.5 w-3.5" />
						Messages
					</div>
					<p className="mt-1 font-semibold text-lg">
						{(activity?.totalIncomingMessages ?? 0) +
							(activity?.totalOutgoingMessages ?? 0)}
					</p>
				</div>
				<div className="rounded-lg border border-border/50 p-2">
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<Activity className="h-3.5 w-3.5" />
						Online
					</div>
					<p className="mt-1 font-semibold text-lg">
						{activity?.totalOnlineEvents ?? 0}
					</p>
				</div>
				<div className="rounded-lg border border-border/50 p-2">
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<Clock className="h-3.5 w-3.5" />
						Minutes
					</div>
					<p className="mt-1 font-semibold text-lg">
						{activity?.days.reduce(
							(total, day) => total + day.approxOnlineMinutes,
							0,
						) ?? 0}
					</p>
				</div>
			</div>

			<div>
				<h3 className="mb-2 font-display font-medium text-sm">
					Activity board
				</h3>
				<div className="grid grid-cols-[repeat(13,minmax(0,1fr))] gap-1">
					{calendarDays.map((day) => {
						const value =
							day.incomingMessages + day.outgoingMessages + day.onlineEvents;
						return (
							<div
								className={cn("h-3 rounded-sm", intensityClass(value))}
								key={day.day}
								title={`${day.day}: ${value} events`}
							/>
						);
					})}
				</div>
			</div>

			<div>
				<h3 className="mb-2 font-display font-medium text-sm">Online status</h3>
				{latestStatuses.length === 0 ? (
					<p className="py-2 text-muted-foreground/70 text-xs">
						No Telegram online-status events captured yet.
					</p>
				) : (
					<div className="space-y-1.5">
						{latestStatuses.map((status) => (
							<div
								className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-2 py-1.5"
								key={status._id}
							>
								<div className="min-w-0">
									<p className="truncate text-xs">{status.senderId}</p>
									<p className="text-muted-foreground/70 text-[11px]">
										{formatStatusTime(status.observedAt)}
									</p>
								</div>
								<Badge className="h-5 text-[10px]" variant="secondary">
									{status.status}
								</Badge>
							</div>
						))}
					</div>
				)}
			</div>
		</section>
	);
}
