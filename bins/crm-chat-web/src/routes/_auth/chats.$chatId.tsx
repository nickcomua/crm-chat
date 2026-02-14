import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "@/components/chats-page";

interface ChatSearchParams {
  messageId?: string;
}

export const Route = createFileRoute("/_auth/chats/$chatId")({
  component: ChatsPage,
  validateSearch: (search: Record<string, unknown>): ChatSearchParams => ({
    messageId:
      typeof search.messageId === "string" ? search.messageId : undefined,
  }),
});
