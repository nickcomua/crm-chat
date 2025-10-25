import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Chat } from "../types";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function getFullName(c: Chat): string {
	return [c.first_name ?? "", c.last_name ?? ""].join(" ").trim();
}

export function chatLabel(c: Chat): string {
	const full = getFullName(c);
	if (full) {
		return full;
	}
	if (c.username) {
		return `@${c.username}`;
	}
	if (c.phone) {
		return c.phone!;
	}
	return c.id;
}

export function suggestDisplayName(c: Chat): string {
	if (c.username) {
		return `@${c.username}`;
	}
	const full = getFullName(c);
	if (full) {
		return full;
	}
	if (c.phone) {
		return c.phone!;
	}
	const CHAT_ID_PREVIEW_LENGTH = 6;
	return `Chat ${c.id.slice(0, CHAT_ID_PREVIEW_LENGTH)}`;
}
