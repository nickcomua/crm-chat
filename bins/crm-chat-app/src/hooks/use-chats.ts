import { useQuery } from "@tanstack/react-query";
import { getChats } from "../services/chat-service";

export function useChats() {
	return useQuery({
		queryKey: ["chats"],
		queryFn: getChats,
	});
}
