import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "@/components/chats-page";

export const Route = createFileRoute("/_auth/chats/$chatId")({
  component: ChatsPage,
});
