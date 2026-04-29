import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Shared chat display-name helper used by chat-list, message-list,
 * search-dialog, and the contacts UI. Falls back to a truncated chatId
 * when `pinnedName` is unset.
 */
export function getChatDisplayName(
	chat: { pinnedName?: string; chatId: string } | undefined | null,
): string {
	if (!chat) {
		return "Chat";
	}
	if (chat.pinnedName) {
		return chat.pinnedName;
	}
	return `Chat ${chat.chatId.slice(0, 8)}`;
}

const WHITESPACE_RE = /\s+/;

/** Return 1-2 uppercase initials from a name. */
export function getInitials(name: string): string {
	const parts = name.trim().split(WHITESPACE_RE);
	if (parts.length >= 2) {
		return (parts[0][0] + parts[1][0]).toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

/** Deterministic background gradient for an avatar based on the name. */
export function getAvatarGradient(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	const hue2 = (hue + 45) % 360;
	return `linear-gradient(135deg, oklch(0.68 0.16 ${hue}), oklch(0.55 0.18 ${hue2}))`;
}
