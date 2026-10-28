export type ChatId = string;

export type ChatKind = "Dialog" | "Group" | "Channel";

export type Chat = { id: ChatId, title: string, kind: ChatKind, };
