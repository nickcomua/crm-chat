import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { ChatList } from "./chat-list";
import { MessageList } from "./message-list";

export function ChatPage(): React.ReactNode {
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  return (
    <div className="flex h-full">
      <div
        className={cn(
          "h-full w-full flex-shrink-0 border-r md:w-80 lg:w-96",
          selectedChatId ? "hidden md:block" : "block"
        )}
      >
        <ChatList
          onSelectChat={setSelectedChatId}
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
            onBack={() => setSelectedChatId(null)}
          />
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
