export type MediaKind =
	| "Photo"
	| "Video"
	| "VideoNote"
	| "Audio"
	| "Voice"
	| "Sticker"
	| "Animation"
	| "Document";

/** Label shown in chat list preview for a media-only message. */
export function mediaKindLabel(kind: MediaKind): string {
	switch (kind) {
		case "Photo":
			return "Photo";
		case "Video":
			return "Video";
		case "VideoNote":
			return "Video message";
		case "Audio":
			return "Audio";
		case "Voice":
			return "Voice message";
		case "Sticker":
			return "Sticker";
		case "Animation":
			return "GIF";
		default:
			return "Document";
	}
}
