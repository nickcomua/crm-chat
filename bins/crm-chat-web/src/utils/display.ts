export function displayClientName(
  client: { kind: string; telegramId: string } | undefined
): string {
  if (!client) {
    return "";
  }
  return `${client.kind} • ${client.telegramId}`;
}

export function displayChatName(
  chat: { pinnedName?: string; chatId: string } | undefined
): string {
  if (!chat) {
    return "Chat";
  }
  if (chat.pinnedName) {
    return chat.pinnedName;
  }
  return `Chat ${chat.chatId.slice(0, 8)}`;
}
