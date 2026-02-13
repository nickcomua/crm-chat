import { useQuery } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  File,
  Image as ImageIcon,
  Loader2,
  Music,
  Sticker,
  Video,
} from "lucide-react";
import { api } from "@/lib/convex";
import { cn } from "@/lib/utils";
import type { MediaKind } from "./media-renderer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaRecord {
  externalId: string;
  kind: MediaKind;
  status: "pending" | "downloading" | "stored" | "failed" | "skipped";
  bytesDownloaded?: number;
  fileSize?: number;
  fileName?: string;
  mimeType?: string;
  chatId: string;
  error?: string;
  createdAt: number;
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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getKindIcon(
  kind: MediaKind
): React.ComponentType<{ className?: string }> {
  switch (kind) {
    case "Photo":
      return ImageIcon;
    case "Video":
    case "VideoNote":
    case "Animation":
      return Video;
    case "Audio":
    case "Voice":
      return Music;
    case "Sticker":
      return Sticker;
    default:
      return File;
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

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar({
  bytesDownloaded,
  fileSize,
}: {
  bytesDownloaded: number;
  fileSize?: number;
}): React.ReactNode {
  const percentage =
    fileSize && fileSize > 0
      ? Math.min(100, Math.round((bytesDownloaded / fileSize) * 100))
      : undefined;

  return (
    <div className="flex w-full items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        {percentage !== undefined ? (
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${percentage}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
        )}
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {percentage !== undefined
          ? `${percentage}%`
          : formatFileSize(bytesDownloaded)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function DownloadingRow({ record }: { record: MediaRecord }): React.ReactNode {
  const Icon = getKindIcon(record.kind);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[13px]">
          {record.fileName ?? kindLabel(record.kind)}
        </p>
        <div className="mt-1">
          <ProgressBar
            bytesDownloaded={record.bytesDownloaded ?? 0}
            fileSize={record.fileSize}
          />
        </div>
      </div>
      {record.fileSize !== undefined && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatFileSize(record.fileSize)}
        </span>
      )}
    </div>
  );
}

function QueuedRow({ record }: { record: MediaRecord }): React.ReactNode {
  const Icon = getKindIcon(record.kind);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/30 px-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
        {record.fileName ?? kindLabel(record.kind)}
      </p>
      {record.fileSize !== undefined && (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          {formatFileSize(record.fileSize)}
        </span>
      )}
    </div>
  );
}

function FailedRow({ record }: { record: MediaRecord }): React.ReactNode {
  const Icon = getKindIcon(record.kind);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-destructive/10">
        <Icon className="h-4 w-4 text-destructive" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[13px]">
          {record.fileName ?? kindLabel(record.kind)}
        </p>
        {record.error && (
          <p className="truncate text-[11px] text-destructive/80">
            {record.error}
          </p>
        )}
      </div>
    </div>
  );
}

function RecentRow({ record }: { record: MediaRecord }): React.ReactNode {
  const Icon = getKindIcon(record.kind);
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        {record.fileName ?? kindLabel(record.kind)}
      </p>
      {record.fileSize !== undefined && (
        <span className="shrink-0 text-[11px] text-muted-foreground/50">
          {formatFileSize(record.fileSize)}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground/40">
        {timeAgo(record.createdAt)}
      </span>
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
            variant === "destructive" ? "text-destructive" : "text-foreground"
          )}
        >
          {title}
        </h3>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-medium text-[10px]",
            variant === "destructive"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground"
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
  const activeMedia = useQuery(api.media.listByStatus, {
    statuses: ["downloading", "pending"],
  });
  const failedMedia = useQuery(api.media.listByStatus, {
    statuses: ["failed"],
  });
  const recentMedia = useQuery(api.media.listByStatus, {
    statuses: ["stored"],
  });

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

  const downloading = activeMedia.filter((m) => m.status === "downloading");
  const queued = activeMedia.filter((m) => m.status === "pending");
  const isEmpty =
    downloading.length === 0 &&
    queued.length === 0 &&
    failedMedia.length === 0 &&
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
              <DownloadingRow key={r.externalId} record={r} />
            ))}
          </Section>

          <Section
            count={queued.length}
            icon={<Clock className="h-4 w-4 text-muted-foreground" />}
            title="Queued"
          >
            {queued.map((r) => (
              <QueuedRow key={r.externalId} record={r} />
            ))}
          </Section>

          <Section
            count={failedMedia.length}
            icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
            title="Failed"
            variant="destructive"
          >
            {failedMedia.map((r) => (
              <FailedRow key={r.externalId} record={r} />
            ))}
          </Section>

          <Section
            count={recentMedia.length}
            icon={<CheckCircle2 className="h-4 w-4 text-muted-foreground/60" />}
            title="Recent"
          >
            {recentMedia.map((r) => (
              <RecentRow key={r.externalId} record={r} />
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}
