/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQuery } from "convex/react";
import type { AnimationItem } from "lottie-web";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, onResultError } from "@/lib/convex";

export interface TelegramCustomEmojiEntityKindDoc {
	documentId: string;
	type: "telegramCustomEmoji";
}

export interface MessageEntityDoc {
	kind: TelegramCustomEmojiEntityKindDoc;
	length: number;
	offset: number;
}

const CUSTOM_EMOJI_RENDER_SIZE = "1.25em";

const supportedImageMimeType = (mimeType: string | undefined): boolean => {
	if (mimeType === undefined) {
		return false;
	}

	return mimeType.toLowerCase().startsWith("image/");
};

const isTgsticker = (mimeType: string | undefined): boolean => {
	const normalized = mimeType?.toLowerCase();
	if (normalized === undefined) {
		return false;
	}

	return normalized.startsWith("application/x-tgsticker");
};

function TgsSticker({
	url,
	onError,
}: {
	url: string;
	onError: () => void;
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
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(
						`Failed to load custom emoji sticker asset: ${response.status}`,
					);
				}

				const body = response.body;
				if (!body) {
					throw new Error("Missing sticker body");
				}

				const ds = new DecompressionStream("gzip");
				const decompressed = body.pipeThrough(ds);
				const text = await new Response(decompressed).text();

				if (cancelled) return;

				const animationData = JSON.parse(text);
				const lottie = (await import("lottie-web/build/player/lottie_light"))
					.default;

				if (cancelled) return;

				animRef.current?.destroy();
				animRef.current = lottie.loadAnimation({
					container,
					animationData,
					renderer: "svg",
					loop: true,
					autoplay: true,
				});
			} catch (error) {
				if (!cancelled) {
					console.warn("Failed to render custom sticker emoji", error);
					onError();
				}
			}
		})();

		return () => {
			cancelled = true;
			animRef.current?.destroy();
			animRef.current = null;
		};
	}, [onError, url]);

	return (
		<div
			className="inline-flex align-[-0.2em]"
			ref={containerRef}
			style={{
				width: CUSTOM_EMOJI_RENDER_SIZE,
				height: CUSTOM_EMOJI_RENDER_SIZE,
			}}
		/>
	);
}

function CustomEmojiEntity({
	documentId,
	fallbackText,
	messageId,
}: {
	documentId: string;
	fallbackText: string;
	messageId: string;
}): React.ReactNode {
	const asset = useQuery(api.model.media.getCustomEmojiAsset, {
		messageId,
		documentId,
	});
	const requestCustomEmojiAsset = useMutation(
		api.model.media.requestCustomEmojiAsset,
	);
	const [hasLoadError, setHasLoadError] = useState(false);

	useEffect(() => {
		setHasLoadError(false);
	}, [asset?.telegramFileId, asset?.url]);

	useEffect(() => {
		if (asset === null) {
			void requestCustomEmojiAsset({ messageId, documentId })
				.then(onResultError)
				.catch((error: unknown) => {
					if (error instanceof Error) {
						console.warn("Custom emoji asset request failed", error.message);
						return;
					}
					console.warn("Custom emoji asset request failed");
				});
			return;
		}
	}, [asset, documentId, messageId, requestCustomEmojiAsset]);

	const shouldRenderAsset =
		asset?.status === "Stored" && asset.url !== undefined && !hasLoadError;
	const shouldRenderImage =
		shouldRenderAsset && supportedImageMimeType(asset?.mimeType);
	const shouldRenderTgs = shouldRenderAsset && isTgsticker(asset?.mimeType);

	if (shouldRenderImage) {
		return (
			<img
				alt={fallbackText}
				className="inline-block align-[-0.2em]"
				style={{
					width: CUSTOM_EMOJI_RENDER_SIZE,
					height: CUSTOM_EMOJI_RENDER_SIZE,
				}}
				data-custom-emoji-document-id={documentId}
				data-testid="custom-emoji-asset"
				loading="lazy"
				src={asset.url}
				onError={() => {
					setHasLoadError(true);
				}}
				onLoad={() => {
					setHasLoadError(false);
				}}
			/>
		);
	}

	if (shouldRenderTgs && asset?.url !== undefined) {
		return <TgsSticker onError={() => setHasLoadError(true)} url={asset.url} />;
	}

	return (
		<span
			className="inline-flex rounded-sm underline decoration-current/50 decoration-dotted underline-offset-2"
			data-custom-emoji-document-id={documentId}
			data-testid="custom-emoji-fallback"
			title={`Telegram custom emoji asset unavailable (${documentId})`}
		>
			{fallbackText}
		</span>
	);
}

export function renderMessageText(
	messageId: string,
	text: string,
	entities: MessageEntityDoc[] | undefined,
): React.ReactNode {
	if (!entities || entities.length === 0) {
		return text;
	}

	const parts: React.ReactNode[] = [];
	let cursor = 0;
	const sortedEntities = [...entities].sort(
		(left, right) => left.offset - right.offset,
	);

	for (const entity of sortedEntities) {
		const start = entity.offset;
		const end = start + entity.length;
		const isValidRange =
			Number.isInteger(start) &&
			Number.isInteger(entity.length) &&
			start >= cursor &&
			entity.length > 0 &&
			end <= text.length;
		if (!isValidRange) {
			continue;
		}

		if (start > cursor) {
			parts.push(
				<Fragment key={`text-${cursor}-${start}`}>
					{text.slice(cursor, start)}
				</Fragment>,
			);
		}

		parts.push(
			<CustomEmojiEntity
				documentId={entity.kind.documentId}
				fallbackText={text.slice(start, end)}
				key={`custom-emoji-${start}-${end}-${entity.kind.documentId}`}
				messageId={messageId}
			/>,
		);
		cursor = end;
	}

	if (cursor < text.length) {
		parts.push(
			<Fragment key={`text-${cursor}-end`}>{text.slice(cursor)}</Fragment>,
		);
	}

	return parts.length === 0 ? text : parts;
}
