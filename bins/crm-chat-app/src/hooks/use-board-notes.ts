import { surrealql } from "@surrealdb/surrealdb";
import { useLiveQuery } from "../contexts/surreal-provider";
import type { BoardNote } from "../types";

export function useBoardNotes(chatId: string) {
	return useLiveQuery<BoardNote>({
		query: surrealql`SELECT
      type::string(id) as id,
      question_id,
      x, y, z, color, width, height
    FROM boardnote
    WHERE chat_id = ${chatId}`,
		liveQuery: surrealql`LIVE SELECT
      type::string(id) as id,
      question_id,
      x, y, z, color, width, height
    FROM boardnote
    WHERE chat_id = ${chatId}`,
		queryKey: ["boardnote", chatId],
	});
}
