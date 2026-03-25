import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "convex-helpers/react/cache";
import { MessageSquare } from "lucide-react";
import { api } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { ChatList } from "./chat-list";
import { MessageList } from "./message-list";

export function ChatsPage(): React.ReactNode {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false }) as { messageId?: string };
  const navigate = useNavigate();
  const selectedChatId = params.chatId ?? null;
  const targetMessageId = search?.messageId;

  const clients = useQuery(api.model.clients.list);
  const chats = useQuery(api.model.chats.list);

  if (import.meta.env.DEV) {
    console.log({ clients });
    console.log({ chats });
  }

  const handleSelectChat = (chatId: string | null): void => {
    if (chatId) {
      navigate({ to: "/chats/$chatId", params: { chatId } });
    } else {
      navigate({ to: "/chats" });
    }
  };

  const handleBack = (): void => {
    navigate({ to: "/chats" });
  };

  return (
    <div className="flex h-full">
      <div
        className={cn(
          "h-full w-full shrink-0 border-border/50 border-r md:w-80 lg:w-96",
          selectedChatId ? "hidden md:block" : "block"
        )}
      >
        <ChatList
          onSelectChat={handleSelectChat}
          selectedChatId={selectedChatId}
        />
      </div>

      <div
        className={cn(
          "h-full flex-1",
          selectedChatId ? "block" : "hidden md:block"
        )}
      >
        {selectedChatId ? (
          <MessageList
            chatId={selectedChatId}
            onBack={handleBack}
            targetMessageId={targetMessageId}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/8">
              <MessageSquare className="h-7 w-7 text-primary/40" />
            </div>
            <h3 className="mt-5 font-display font-medium text-base">
              Select a chat
            </h3>
            <p className="mt-1.5 max-w-xs text-muted-foreground/70 text-sm">
              Choose a conversation from the list to view messages
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
