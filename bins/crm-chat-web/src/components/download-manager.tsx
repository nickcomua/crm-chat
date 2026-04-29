import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import {
	AlertTriangle,
	CheckCircle2,
	Clock,
	Download,
	ExternalLink,
	File,
	Image as ImageIcon,
	Loader2,
	Music,
	RefreshCw,
	Sticker,
	Video,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, onResultError } from "@/lib/convex";
import { cn } from "@/lib/utils";
import type { MediaKind } from "./media-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaRecord {
	bytesDownloaded?: number;
	chatId: string;
	chatName?: string;
	createdAt: number;
	error?: string;
	fileName?: string;
	fileSize?: number;
	kind: MediaKind;
	messageId: string;
	messageTs?: number;
	mimeType?: string;
	status: "Pending" | "Downloading" | "Stored" | "Failed" | "Skipped";
	telegramFileId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
	if (bytesPerSec < 1024) {
		return `${Math.round(bytesPerSec)} B/s`;
	}
	if (bytesPerSec < 1024 * 1024) {
		return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
	}
	return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function KindIcon({
	kind,
	className,
}: {
	kind: MediaKind;
	className?: string;
}): React.ReactNode {
	switch (kind) {
		case "Photo":
			return <ImageIcon className={className} />;
		case "Video":
		case "VideoNote":
		case "Animation":
			return <Video className={className} />;
		case "Audio":
		case "Voice":
			return <Music className={className} />;
		case "Sticker":
			return <Sticker className={className} />;
		default:
			return <File className={className} />;
	}
}

function kindLabel(kind: MediaKind): string {
	switch (kind) {
		case "VideoNote":
			return "Video note";
		case "Voice":
			return "Voice message";
		case "Animation":
			return "GIF";
		default:
			return kind;
	}
}

function timeAgo(ms: number): string {
	const diff = Date.now() - ms;
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) {
		return "just now";
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatDate(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	const isThisYear = d.getFullYear() === now.getFullYear();
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(isThisYear ? {} : { year: "numeric" }),
	});
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

/** Chat name + message date line. */
function MediaMeta({ record }: { record: MediaRecord }): React.ReactNode {
	const label = record.chatName ?? record.chatId;
	const date = record.messageTs ? formatDate(record.messageTs) : undefined;

	return (
		<p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground/70">
			<span className="truncate">{label}</span>
			{date && (
				<>
					<span className="shrink-0">·</span>
					<span className="shrink-0">{date}</span>
				</>
			)}
		</p>
	);
}

/** Small button that navigates to the message in its chat. */
function GoToChatButton({ record }: { record: MediaRecord }): React.ReactNode {
	return (
		<Link
			className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			params={{ chatId: record.chatId }}
			search={{ messageId: record.messageId }}
			to="/chats/$chatId"
		>
			<ExternalLink className="h-3 w-3" />
			Chat
		</Link>
	);
}

// ---------------------------------------------------------------------------
// Speed tracking hook
// ---------------------------------------------------------------------------

/** Compute download speed from reactive bytesDownloaded changes. */
function useDownloadSpeed(bytesDownloaded: number): number {
	const prevRef = useRef({ bytes: 0, time: 0 });
	const [speed, setSpeed] = useState(0);

	useEffect(() => {
		const now = Date.now();
		if (prevRef.current.time === 0) {
			prevRef.current = { bytes: bytesDownloaded, time: now };
			return;
		}
		const elapsed = (now - prevRef.current.time) / 1000;
		if (elapsed >= 1 && bytesDownloaded > prevRef.current.bytes) {
			const delta = bytesDownloaded - prevRef.current.bytes;
			setSpeed(delta / elapsed);
			prevRef.current = { bytes: bytesDownloaded, time: now };
		} else if (bytesDownloaded < prevRef.current.bytes) {
			prevRef.current = { bytes: bytesDownloaded, time: now };
			setSpeed(0);
		}
	}, [bytesDownloaded]);

	return speed;
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function CancelButton({ record }: { record: MediaRecord }): React.ReactNode {
	const cancelDownload = useMutation(api.model.media.cancelDownload);
	return (
		<button
			className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			onClick={() =>
				cancelDownload({ telegramFileId: record.telegramFileId }).then(
					onResultError,
				)
			}
			type="button"
		>
			<X className="h-3 w-3" />
			Cancel
		</button>
	);
}

function DownloadingRow({ record }: { record: MediaRecord }): React.ReactNode {
	const downloaded = record.bytesDownloaded ?? 0;
	const total = record.fileSize;
	const speed = useDownloadSpeed(downloaded);
	const hasSize = total !== undefined && total > 0;
	const percentage = hasSize
		? Math.min(100, Math.round((downloaded / total) * 100))
		: undefined;

	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2.5">
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
				<KindIcon className="h-4 w-4 text-primary" kind={record.kind} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline justify-between gap-2">
					<p className="truncate font-medium text-[13px]">
						{record.fileName ?? kindLabel(record.kind)}
					</p>
					{speed > 0 && (
						<span className="shrink-0 text-[11px] text-primary tabular-nums">
							{formatSpeed(speed)}
						</span>
					)}
				</div>
				<MediaMeta record={record} />
				{hasSize ? (
					<>
						<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary transition-all duration-500"
								style={{ width: `${percentage}%` }}
							/>
						</div>
						<p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
							{formatFileSize(downloaded)} / {formatFileSize(total)} —{" "}
							{percentage}%
						</p>
					</>
				) : (
					<p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
						<Loader2 className="h-3 w-3 animate-spin" />
						{formatFileSize(downloaded)}
					</p>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<GoToChatButton record={record} />
				<CancelButton record={record} />
			</div>
		</div>
	);
}

function QueuedRow({ record }: { record: MediaRecord }): React.ReactNode {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/30 px-3 py-2">
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
				<KindIcon
					className="h-4 w-4 text-muted-foreground"
					kind={record.kind}
				/>
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate text-[13px] text-muted-foreground">
					{record.fileName ?? kindLabel(record.kind)}
				</p>
				<MediaMeta record={record} />
			</div>
			{record.fileSize !== undefined && (
				<span className="shrink-0 text-[11px] text-muted-foreground/60">
					{formatFileSize(record.fileSize)}
				</span>
			)}
			<div className="flex shrink-0 items-center gap-1.5">
				<GoToChatButton record={record} />
				<CancelButton record={record} />
			</div>
		</div>
	);
}

function FailedRow({ record }: { record: MediaRecord }): React.ReactNode {
	const retryDownload = useMutation(api.model.media.retryDownload);
	return (
		<div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-destructive/10">
				<KindIcon className="h-4 w-4 text-destructive" kind={record.kind} />
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-[13px]">
					{record.fileName ?? kindLabel(record.kind)}
				</p>
				<MediaMeta record={record} />
				{record.error && (
					<p className="truncate text-[11px] text-destructive/80">
						{record.error}
					</p>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<GoToChatButton record={record} />
				<button
					className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={() =>
						retryDownload({ telegramFileId: record.telegramFileId }).then(
							onResultError,
						)
					}
					type="button"
				>
					<RefreshCw className="h-3 w-3" />
					Retry
				</button>
			</div>
		</div>
	);
}

function RecentRow({ record }: { record: MediaRecord }): React.ReactNode {
	return (
		<div className="flex items-center gap-3 rounded-md px-3 py-1.5">
			<KindIcon
				className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
				kind={record.kind}
			/>
			<div className="min-w-0 flex-1">
				<p className="truncate text-[12px] text-muted-foreground">
					{record.fileName ?? kindLabel(record.kind)}
				</p>
				<MediaMeta record={record} />
			</div>
			{record.fileSize !== undefined && (
				<span className="shrink-0 text-[11px] text-muted-foreground/50">
					{formatFileSize(record.fileSize)}
				</span>
			)}
			<span className="shrink-0 text-[11px] text-muted-foreground/40">
				{timeAgo(record.createdAt)}
			</span>
			<GoToChatButton record={record} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
	title,
	icon,
	count,
	children,
	variant = "default",
}: {
	title: string;
	icon: React.ReactNode;
	count: number;
	children: React.ReactNode;
	variant?: "default" | "destructive";
}): React.ReactNode {
	if (count === 0) {
		return null;
	}
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				{icon}
				<h3
					className={cn(
						"font-medium text-[13px]",
						variant === "destructive" ? "text-destructive" : "text-foreground",
					)}
				>
					{title}
				</h3>
				<span
					className={cn(
						"rounded-full px-1.5 py-0.5 font-medium text-[10px]",
						variant === "destructive"
							? "bg-destructive/10 text-destructive"
							: "bg-muted text-muted-foreground",
					)}
				>
					{count}
				</span>
			</div>
			<div className="space-y-1.5">{children}</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DownloadManager(): React.ReactNode {
	const activeMedia = useQuery(api.model.media.listByStatus, {
		statuses: ["Downloading", "Pending"],
	}) as MediaRecord[] | undefined;
	const failedMedia = useQuery(api.model.media.listByStatus, {
		statuses: ["Failed"],
	}) as MediaRecord[] | undefined;
	const recentMedia = useQuery(api.model.media.listByStatus, {
		statuses: ["Stored"],
	}) as MediaRecord[] | undefined;
	const counts = useQuery(api.model.media.countByStatus, {
		statuses: ["Pending", "Failed"],
	}) as Array<{ status: string; count: number }> | undefined;

	const isLoading =
		activeMedia === undefined ||
		failedMedia === undefined ||
		recentMedia === undefined;

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	const downloading = activeMedia.filter((m) => m.status === "Downloading");
	const queued = activeMedia.filter((m) => m.status === "Pending");
	const pendingCount =
		counts?.find((c) => c.status === "Pending")?.count ?? queued.length;
	const failedCount =
		counts?.find((c) => c.status === "Failed")?.count ?? failedMedia.length;
	const isEmpty =
		downloading.length === 0 &&
		pendingCount === 0 &&
		failedCount === 0 &&
		recentMedia.length === 0;

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2">
				<Download className="h-5 w-5 text-foreground" />
				<h2 className="font-display font-semibold text-lg tracking-tight">
					Downloads
				</h2>
			</div>

			{isEmpty ? (
				<div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
					<Download className="h-8 w-8 opacity-30" />
					<p className="text-sm">No media downloads yet</p>
					<p className="text-[12px] opacity-60">
						Enable scan on a chat to start downloading media
					</p>
				</div>
			) : (
				<div className="space-y-6">
					<Section
						count={downloading.length}
						icon={<Loader2 className="h-4 w-4 animate-spin text-primary" />}
						title="Downloading"
					>
						{downloading.map((r) => (
							<DownloadingRow key={r.telegramFileId} record={r} />
						))}
					</Section>

					<Section
						count={pendingCount}
						icon={<Clock className="h-4 w-4 text-muted-foreground" />}
						title="Queued"
					>
						{queued.map((r) => (
							<QueuedRow key={r.telegramFileId} record={r} />
						))}
					</Section>

					<Section
						count={failedCount}
						icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
						title="Failed"
						variant="destructive"
					>
						{failedMedia.map((r) => (
							<FailedRow key={r.telegramFileId} record={r} />
						))}
					</Section>

					<Section
						count={recentMedia.length}
						icon={<CheckCircle2 className="h-4 w-4 text-muted-foreground/60" />}
						title="Recent"
					>
						{recentMedia.map((r) => (
							<RecentRow key={r.telegramFileId} record={r} />
						))}
					</Section>
				</div>
			)}
		</div>
	);
}
