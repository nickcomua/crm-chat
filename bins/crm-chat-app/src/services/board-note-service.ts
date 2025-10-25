import { commands } from "../bindings";
import type { BoardNote, BoardNoteCreate, BoardNotePatch } from "../types";

export async function getBoardNotes(chatId: string): Promise<BoardNote[]> {
	const result = await commands.getBoardNotes(chatId);
	if (result.status === "error") {
		throw new Error(result.error);
	}
	return result.data;
}

export async function createBoardNote(
	boardNote: BoardNoteCreate
): Promise<string> {
	const result = await commands.createBoardNote(boardNote);
	if (result.status === "error") {
		throw new Error(result.error);
	}
	return result.data;
}

export async function updateBoardNote(
	id: string,
	patch: BoardNotePatch
): Promise<void> {
	const result = await commands.mergeBoardNote(id, patch);
	if (result.status === "error") {
		throw new Error(result.error);
	}
}

export async function deleteBoardNote(id: string): Promise<void> {
	const result = await commands.deleteBoardNote(id);
	if (result.status === "error") {
		throw new Error(result.error);
	}
}
