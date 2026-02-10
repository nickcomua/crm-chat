import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { MessageSquare } from "lucide-react";
import { api } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { ChatList } from "./chat-list";
import { MessageList } from "./message-list";

export function ChatsPage(): React.ReactNode {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const selectedChatId = params.chatId ?? null;

  const clients = useQuery(api.clients.list);
  const chats = useQuery(api.chats.list);

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
          "h-full w-full shrink-0 border-r md:w-80 lg:w-96",
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
          <MessageList chatId={selectedChatId} onBack={handleBack} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <MessageSquare className="h-8 w-8 text-primary/60" />
            </div>
            <h3 className="mt-4 font-display font-medium text-lg">
              Select a chat
            </h3>
            <p className="mt-1 max-w-sm text-muted-foreground text-sm">
              Choose a conversation from the list to view messages
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
