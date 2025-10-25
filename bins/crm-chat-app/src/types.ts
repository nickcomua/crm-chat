export type {
	BoardNote,
	BoardNoteCreate,
	BoardNotePatch,
	Chat,
	WordDefinition,
} from "./bindings";

// Additional types if needed, e.g., for messages (placeholder)
export type Message = {
	id: string;
	content: string;
	chat_id: string;
	timestamp: string;
};

// QAPair type for chat messages if needed
export type QAPair = {
	id: string;
	question: string;
	answer: string;
	chat_id: string;
};
