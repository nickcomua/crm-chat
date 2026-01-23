import { useNavigate, useParams } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/lib/spacetime";
import { cn } from "@/lib/utils";
import { ChatList } from "./chat-list";
import { MessageList } from "./message-list";

export function ChatsPage(): React.ReactNode {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const selectedChatId = (params as { chatId?: string }).chatId ?? null;

  const [clients] = useTable(tables.client);
  const [humans] = useTable(tables.human);
  const [chats] = useTable(tables.chat);
  const [tasks] = useTable(tables.task);

  if (import.meta.env.DEV) {
    console.log({ clients });
    console.log({ humans });
    console.log({ chats });
    console.log({ tasks });
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
          "h-full w-full flex-shrink-0 border-r md:w-80 lg:w-96",
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
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <MessageSquare className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 font-medium text-lg">Select a chat</h3>
            <p className="mt-1 max-w-sm text-muted-foreground text-sm">
              Choose a conversation from the list to view messages
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
