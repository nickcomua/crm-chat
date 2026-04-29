import { useQuery } from "convex-helpers/react/cache";
import { Bell, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { api } from "@/lib/convex";
import { NotificationsPanel } from "./notifications-panel";
import { Button } from "./ui/button";

interface NotificationsBellPanelProps {
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

export function NotificationsBellPanel({
	open,
	onOpenChange,
}: NotificationsBellPanelProps): React.ReactNode {
	const notifications = useQuery(api.model.notifications.list);
	const panelRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const pendingCount = notifications?.length ?? 0;

	useEffect(() => {
		if (!open) {
			return;
		}

		function handleClick(e: MouseEvent): void {
			if (
				panelRef.current &&
				!panelRef.current.contains(e.target as Node) &&
				buttonRef.current &&
				!buttonRef.current.contains(e.target as Node)
			) {
				onOpenChange(false);
			}
		}

		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open, onOpenChange]);

	useEffect(() => {
		if (!open) {
			return;
		}

		function handleKey(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				onOpenChange(false);
			}
		}

		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [open, onOpenChange]);

	return (
		<>
			<Button
				className="relative h-8 w-8"
				onClick={() => onOpenChange(!open)}
				ref={buttonRef}
				size="icon"
				title="Notifications"
				variant="ghost"
			>
				<Bell className="h-3.5 w-3.5" />
				{pendingCount > 0 && (
					<span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-semibold text-[9px] text-destructive-foreground shadow-sm">
						{pendingCount > 9 ? "9+" : pendingCount}
					</span>
				)}
				<span className="sr-only">Notifications</span>
			</Button>

			{open && (
				<>
					<div
						aria-hidden="true"
						className="fixed inset-0 z-40 bg-black/10 backdrop-blur-[1px]"
						onClick={() => onOpenChange(false)}
					/>
					<div
						className="fixed top-12 right-0 z-50 flex h-[calc(100vh-3rem)] w-80 flex-col border-l bg-card/98 shadow-xl backdrop-blur-xl"
						ref={panelRef}
					>
						<div className="flex items-center justify-between border-b px-4 py-2.5">
							<div className="flex items-center gap-2">
								<Bell className="h-3.5 w-3.5 text-primary" />
								<h2 className="font-display font-semibold text-[13px]">
									Notifications
								</h2>
								{pendingCount > 0 && (
									<span className="flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1.5 font-semibold text-[10px] text-primary-foreground">
										{pendingCount}
									</span>
								)}
							</div>
							<Button
								className="h-7 w-7"
								onClick={() => onOpenChange(false)}
								size="icon"
								title="Close notifications"
								variant="ghost"
							>
								<X className="h-3.5 w-3.5" />
							</Button>
						</div>
						<div className="flex-1 overflow-y-auto">
							<NotificationsPanel />
						</div>
					</div>
				</>
			)}
		</>
	);
}
