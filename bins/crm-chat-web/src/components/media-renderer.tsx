import { useMutation } from "convex/react";
import type { AnimationItem } from "lottie-web";
import {
  Download,
  File,
  Image as ImageIcon,
  Loader2,
  Music,
  Sticker,
  Video,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, onResultError } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { type MediaKind, mediaKindLabel } from "./media-types";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";

type MediaStatus = "Pending" | "Downloading" | "Stored" | "Failed" | "Skipped";

export interface MediaInfo {
  bytesDownloaded?: number;
  duration?: number;
  fileName?: string;
  fileSize?: number;
  height?: number;
  kind: MediaKind;
  messageId: string;
  mimeType?: string;
  status: MediaStatus;
  telegramFileId: string;
  url?: string;
  width?: number;
}

interface MediaRendererProps {
  isOutgoing: boolean;
  media: MediaInfo;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Default MIME type for a media kind (used as fallback when mimeType is absent). */
function defaultMimeType(kind: MediaKind): string {
  switch (kind) {
    case "Photo":
      return "image/jpeg";
    case "Video":
    case "VideoNote":
    case "Animation":
      return "video/mp4";
    case "Audio":
      return "audio/mpeg";
    case "Voice":
      return "audio/ogg";
    case "Sticker":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Download a file with a proper filename via programmatic fetch + blob. */
function downloadFile(url: string, fileName: string): void {
  fetch(url)
    .then((res) => res.blob())
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(blobUrl);
    });
}

function PendingMedia({
  kind,
  isOutgoing,
}: {
  kind: MediaKind;
  isOutgoing: boolean;
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 py-1">
      <Loader2
        className={cn(
          "h-4 w-4 animate-spin",
          isOutgoing ? "text-primary-foreground/50" : "text-muted-foreground/50"
        )}
      />
      <KindIcon
        className={cn(
          "h-4 w-4",
          isOutgoing ? "text-primary-foreground/60" : "text-muted-foreground/60"
        )}
        kind={kind}
      />
      <span
        className={cn(
          "text-[12px] italic",
          isOutgoing ? "text-primary-foreground/60" : "text-muted-foreground/60"
        )}
      >
        Loading {kind.toLowerCase()}…
      </span>
    </div>
  );
}

function DownloadingMedia({
  media,
  isOutgoing,
}: {
  media: MediaInfo;
  isOutgoing: boolean;
}): React.ReactNode {
  const downloaded = media.bytesDownloaded ?? 0;
  const total = media.fileSize;
  const percentage =
    total && total > 0
      ? Math.min(100, Math.round((downloaded / total) * 100))
      : undefined;

  return (
    <div className="flex items-center gap-2 py-1">
      <Loader2
        className={cn(
          "h-4 w-4 animate-spin",
          isOutgoing ? "text-primary-foreground/50" : "text-muted-foreground/50"
        )}
      />
      <KindIcon
        className={cn(
          "h-4 w-4",
          isOutgoing ? "text-primary-foreground/60" : "text-muted-foreground/60"
        )}
        kind={media.kind}
      />
      <div className="flex min-w-20 flex-1 flex-col gap-1">
        <div
          className={cn(
            "h-1 overflow-hidden rounded-full",
            isOutgoing ? "bg-primary-foreground/20" : "bg-muted"
          )}
        >
          {percentage === undefined ? (
            <div
              className={cn(
                "h-full w-1/3 animate-pulse rounded-full",
                isOutgoing ? "bg-primary-foreground/40" : "bg-primary/60"
              )}
            />
          ) : (
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                isOutgoing ? "bg-primary-foreground/60" : "bg-primary"
              )}
              style={{ width: `${percentage}%` }}
            />
          )}
        </div>
        <span
          className={cn(
            "text-[10px] tabular-nums",
            isOutgoing
              ? "text-primary-foreground/50"
              : "text-muted-foreground/50"
          )}
        >
          {percentage === undefined
            ? formatFileSize(downloaded)
            : `${percentage}%`}
          {total !== undefined && ` / ${formatFileSize(total)}`}
        </span>
      </div>
    </div>
  );
}

function FailedMedia({
  kind,
  isOutgoing,
}: {
  kind: MediaKind;
  isOutgoing: boolean;
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 py-1">
      <KindIcon
        className={cn(
          "h-4 w-4",
          isOutgoing ? "text-primary-foreground/40" : "text-muted-foreground/40"
        )}
        kind={kind}
      />
      <span
        className={cn(
          "text-[12px] italic",
          isOutgoing ? "text-primary-foreground/40" : "text-muted-foreground/40"
        )}
      >
        {kind} unavailable
      </span>
    </div>
  );
}

function SkippedMedia({
  media,
  isOutgoing,
}: {
  media: MediaInfo;
  isOutgoing: boolean;
}): React.ReactNode {
  const requestDownload = useMutation(api.media.requestDownload);
  return (
    <button
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
        isOutgoing
          ? "bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "bg-muted/60 hover:bg-muted"
      )}
      onClick={() =>
        requestDownload({ telegramFileId: media.telegramFileId }).then(
          onResultError
        )
      }
      type="button"
    >
      <Download
        className={cn(
          "h-4 w-4 shrink-0",
          isOutgoing ? "text-primary-foreground/60" : "text-muted-foreground/60"
        )}
      />
      <KindIcon
        className={cn(
          "h-4 w-4",
          isOutgoing ? "text-primary-foreground/60" : "text-muted-foreground/60"
        )}
        kind={media.kind}
      />
      <span
        className={cn(
          "text-[12px]",
          isOutgoing ? "text-primary-foreground/60" : "text-muted-foreground/60"
        )}
      >
        Download {mediaKindLabel(media.kind).toLowerCase()}
      </span>
    </button>
  );
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

function MediaLightbox({
  children,
  media,
}: {
  children: React.ReactNode;
  media: MediaInfo;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const isVideo =
    media.kind === "Video" ||
    media.kind === "VideoNote" ||
    media.kind === "Animation";

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <button className="cursor-pointer text-left" type="button">
          {children}
        </button>
      </DialogTrigger>
      <DialogContent
        className="w-auto max-w-[95vw] border-none bg-black/95 p-2 sm:max-w-[95vw]"
        showCloseButton
      >
        <DialogTitle className="sr-only">
          {mediaKindLabel(media.kind)}
        </DialogTitle>
        {isVideo ? (
          <video
            autoPlay
            className="max-h-[88vh] max-w-[95vw] rounded"
            controls
            playsInline
          >
            <source
              src={media.url}
              type={media.mimeType ?? defaultMimeType(media.kind)}
            />
            <track kind="captions" />
          </video>
        ) : (
          <img
            alt={mediaKindLabel(media.kind)}
            className="max-h-[88vh] max-w-[95vw] rounded object-contain"
            height={media.height}
            src={media.url}
            width={media.width}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentMedia({
  media,
  isOutgoing,
}: MediaRendererProps): React.ReactNode {
  return (
    <button
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left",
        isOutgoing
          ? "bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "bg-muted/60 hover:bg-muted"
      )}
      onClick={() => {
        if (media.url) {
          downloadFile(media.url, media.fileName ?? "document");
        }
      }}
      type="button"
    >
      <Download
        className={cn(
          "h-4 w-4 shrink-0",
          isOutgoing ? "text-primary-foreground/70" : "text-muted-foreground/70"
        )}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate font-medium text-[12px]",
            isOutgoing ? "text-primary-foreground" : "text-foreground"
          )}
        >
          {media.fileName ?? "Document"}
        </p>
        {media.fileSize !== undefined && (
          <p
            className={cn(
              "text-[10px]",
              isOutgoing
                ? "text-primary-foreground/50"
                : "text-muted-foreground/50"
            )}
          >
            {formatFileSize(media.fileSize)}
          </p>
        )}
      </div>
    </button>
  );
}

/** Renders a TGS animated sticker (gzipped Lottie JSON) via lottie-web. */
function TgsSticker({
  url,
  width,
  height,
}: {
  url: string;
  width: number;
  height: number;
}): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<AnimationItem | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;

    (async () => {
      const res = await fetch(url);
      if (cancelled) {
        return;
      }

      const body = res.body;
      if (!body) {
        return;
      }

      // Decompress gzip using the browser's built-in DecompressionStream
      const ds = new DecompressionStream("gzip");
      const decompressed = body.pipeThrough(ds);
      const text = await new Response(decompressed).text();
      if (cancelled) {
        return;
      }

      const animationData = JSON.parse(text);

      const lottie = (await import("lottie-web/build/player/lottie_light"))
        .default;

      animRef.current = lottie.loadAnimation({
        container,
        animationData,
        renderer: "svg",
        loop: true,
        autoplay: true,
      });
    })();

    return () => {
      cancelled = true;
      animRef.current?.destroy();
      animRef.current = null;
    };
  }, [url]);

  return (
    <div
      className="max-h-[180px] max-w-[180px]"
      ref={containerRef}
      style={{ width, height }}
    />
  );
}

function StickerMedia({ media }: { media: MediaInfo }): React.ReactNode {
  const mime = media.mimeType ?? defaultMimeType(media.kind);
  const w = media.width ?? 180;
  const h = media.height ?? 180;

  if (mime === "video/webm") {
    return (
      <video
        autoPlay
        className="max-h-[180px] max-w-[180px]"
        height={h}
        loop
        muted
        playsInline
        width={w}
      >
        <source src={media.url} type="video/webm" />
        <track kind="captions" />
      </video>
    );
  }

  if (mime === "application/x-tgsticker") {
    if (!media.url) {
      return (
        <img
          alt="Sticker"
          className="max-h-[180px] max-w-[180px]"
          height={h}
          width={w}
        />
      );
    }
    return <TgsSticker height={h} url={media.url} width={w} />;
  }

  return (
    <img
      alt="Sticker"
      className="max-h-[180px] max-w-[180px]"
      height={h}
      loading="lazy"
      src={media.url}
      width={w}
    />
  );
}

function StoredMedia({
  media,
  isOutgoing,
}: MediaRendererProps): React.ReactNode {
  switch (media.kind) {
    case "Photo":
      return (
        <MediaLightbox media={media}>
          <img
            alt="Shared media"
            className="max-h-[300px] max-w-full rounded-lg object-cover"
            height={media.height}
            loading="lazy"
            src={media.url}
            width={media.width}
          />
        </MediaLightbox>
      );

    case "Sticker":
      return <StickerMedia media={media} />;

    case "Animation":
      return (
        <MediaLightbox media={media}>
          <video
            autoPlay
            className="max-h-[300px] max-w-full rounded-lg"
            loop
            muted
            playsInline
          >
            <source
              src={media.url}
              type={media.mimeType ?? defaultMimeType(media.kind)}
            />
            <track kind="captions" />
          </video>
        </MediaLightbox>
      );

    case "Video":
    case "VideoNote":
      return (
        <MediaLightbox media={media}>
          <div className="relative">
            <video
              className={cn(
                "max-h-[300px] max-w-full",
                media.kind === "VideoNote" ? "rounded-full" : "rounded-lg"
              )}
              playsInline
              preload="metadata"
            >
              <source
                src={media.url}
                type={media.mimeType ?? defaultMimeType(media.kind)}
              />
              <track kind="captions" />
            </video>
            {media.duration !== undefined && (
              <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
                {formatDuration(media.duration)}
              </span>
            )}
          </div>
        </MediaLightbox>
      );

    case "Audio":
    case "Voice":
      return (
        <div className="flex min-w-[200px] items-center gap-2">
          <audio controls preload="metadata">
            <source
              src={media.url}
              type={media.mimeType ?? defaultMimeType(media.kind)}
            />
            <track kind="captions" />
          </audio>
          {media.duration !== undefined && (
            <span
              className={cn(
                "shrink-0 text-[11px]",
                isOutgoing
                  ? "text-primary-foreground/50"
                  : "text-muted-foreground/50"
              )}
            >
              {formatDuration(media.duration)}
            </span>
          )}
        </div>
      );

    default:
      return <DocumentMedia isOutgoing={isOutgoing} media={media} />;
  }
}

export function MediaRenderer({
  media,
  isOutgoing,
}: MediaRendererProps): React.ReactNode {
  if (media.status === "Downloading") {
    return <DownloadingMedia isOutgoing={isOutgoing} media={media} />;
  }

  if (media.status === "Pending") {
    return <PendingMedia isOutgoing={isOutgoing} kind={media.kind} />;
  }

  if (media.status === "Skipped") {
    return <SkippedMedia isOutgoing={isOutgoing} media={media} />;
  }

  if (media.status === "Failed" || !media.url) {
    return <FailedMedia isOutgoing={isOutgoing} kind={media.kind} />;
  }

  return <StoredMedia isOutgoing={isOutgoing} media={media} />;
}
