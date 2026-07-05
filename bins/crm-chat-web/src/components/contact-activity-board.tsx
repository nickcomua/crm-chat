import { useQuery } from "convex/react";
import { Activity, Clock, MessageSquare } from "lucide-react";
import { useState } from "react";
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

interface PresenceStatusRow {
	_id: Id<"contactPresence">;
	senderId: string;
	status:
		| "online"
		| "offline"
		| "recently"
		| "lastWeek"
		| "lastMonth"
		| "empty";
	observedAt: number;
	expiresAt?: number;
	wasOnlineAt?: number;
}

interface OnlineWindow {
	start: number;
	end: number;
	senderId: string;
}

const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * ONE_MINUTE_MS;

function formatStatusTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatTimelineTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {
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

function buildOnlineWindows(
	statuses: readonly PresenceStatusRow[],
	now: number,
): OnlineWindow[] {
	const rangeStart = now - ONE_DAY_MS;
	const windows = statuses
		.filter((status) => status.status === "online")
		.map((status) => {
			const rawStart = status.wasOnlineAt ?? status.observedAt;
			const rawEnd =
				status.expiresAt && status.expiresAt > rawStart
					? status.expiresAt
					: status.observedAt + ONE_MINUTE_MS;
			return {
				start: Math.max(rawStart, rangeStart),
				end: Math.min(rawEnd, now + ONE_MINUTE_MS),
				senderId: status.senderId,
			};
		})
		.filter((window) => window.end > rangeStart && window.end > window.start)
		.sort((left, right) => left.start - right.start);

	const merged: OnlineWindow[] = [];
	for (const window of windows) {
		const previous = merged.at(-1);
		if (
			previous &&
			previous.senderId === window.senderId &&
			window.start <= previous.end
		) {
			previous.end = Math.max(previous.end, window.end);
			continue;
		}
		merged.push({ ...window });
	}

	return merged;
}

function windowStyle(window: OnlineWindow, now: number): React.CSSProperties {
	const rangeStart = now - ONE_DAY_MS;
	const left = ((window.start - rangeStart) / ONE_DAY_MS) * 100;
	const width = ((window.end - window.start) / ONE_DAY_MS) * 100;
	return {
		left: `${Math.max(0, Math.min(left, 100))}%`,
		width: `${Math.max(1.5, Math.min(width, 100))}%`,
	};
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
	const [now] = useState(() => Date.now());
	const statusRows = statuses ?? [];
	const calendarDays = buildCalendarDays(activity?.days ?? []);
	const latestStatuses = statusRows.slice(0, 10);
	const onlineWindows = buildOnlineWindows(statusRows, now);
	const totalMessages =
		(activity?.totalIncomingMessages ?? 0) +
		(activity?.totalOutgoingMessages ?? 0);
	const totalOnlineMinutes =
		activity?.days.reduce((total, day) => total + day.approxOnlineMinutes, 0) ??
		0;

	return (
		<section className="space-y-3">
			<div className="grid grid-cols-3 gap-2">
				<div className="rounded-lg border border-border/50 p-2">
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<MessageSquare className="h-3.5 w-3.5" />
						Messages
					</div>
					<p className="mt-1 font-semibold text-lg">{totalMessages}</p>
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
					<p className="mt-1 font-semibold text-lg">{totalOnlineMinutes}</p>
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
				<div className="mb-2 flex items-center justify-between gap-2">
					<h3 className="font-display font-medium text-sm">Online timeline</h3>
					<span className="text-muted-foreground/70 text-[11px]">Last 24h</span>
				</div>
				{onlineWindows.length === 0 ? (
					<p className="py-2 text-muted-foreground/70 text-xs">
						No online intervals captured in the last 24 hours.
					</p>
				) : (
					<div className="space-y-2" data-testid="contact-online-timeline">
						<span className="sr-only">Online timeline for this contact</span>
						<div className="relative h-8 rounded-md border border-border/50 bg-muted/50">
							{onlineWindows.map((window) => (
								<div
									className="absolute top-1.5 bottom-1.5 rounded-sm bg-emerald-500 shadow-sm"
									key={`${window.senderId}:${window.start}:${window.end}`}
									style={windowStyle(window, now)}
									title={`${window.senderId}: ${formatTimelineTime(
										window.start,
									)} - ${formatTimelineTime(window.end)}`}
								/>
							))}
						</div>
						<div className="flex justify-between text-muted-foreground/70 text-[11px]">
							<span>{formatTimelineTime(now - ONE_DAY_MS)}</span>
							<span>{formatTimelineTime(now)}</span>
						</div>
						<div className="space-y-1">
							{onlineWindows.slice(-4).map((window) => (
								<p
									className="truncate text-muted-foreground text-[11px]"
									key={`${window.senderId}:${window.start}`}
								>
									Online from {formatStatusTime(window.start)} to{" "}
									{formatStatusTime(window.end)} via {window.senderId}
								</p>
							))}
						</div>
					</div>
				)}
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
