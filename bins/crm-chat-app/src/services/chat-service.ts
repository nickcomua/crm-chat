import { commands } from "../bindings";
import type { Chat } from "../types";

export async function getChats(): Promise<Chat[]> {
	const result = await commands.getChats();
	if (result.status === "error") {
		throw new Error(result.error);
	}
	return result.data;
}

export async function updateChatPin(
	chatId: string,
	isPinned: boolean,
	pinnedName?: string
): Promise<void> {
	const result = await commands.updateChatPin(
		chatId,
		isPinned,
		pinnedName || null
	);
	if (result.status === "error") {
		throw new Error(result.error);
	}
}

export async function updateChatName(
	chatId: string,
	name: string
): Promise<void> {
	const result = await commands.updateChatName(chatId, name);
	if (result.status === "error") {
		throw new Error(result.error);
	}
}

// Placeholder for getMessages; implement when backend is ready
export async function getMessages(chatId: string): Promise<Chat[]> {
	const result = await commands.getMessages(chatId);
	if (result.status === "error") {
		throw new Error(result.error);
	}
	return result.data;
}
