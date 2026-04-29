import { useQuery } from "convex-helpers/react/cache";
import { api, type Id } from "@/lib/convex";

export interface ContactForChat {
	contactId: Id<"contacts">;
	displayName: string;
	senderId: string;
}

/**
 * Returns the contacts that touch the given chat. For Dialog chats this is
 * at most one; for Group chats it may be several. Uses the cached query so
 * multiple consumers share the same subscription.
 */
export function useContactForChat(chatId: string | undefined): {
	contacts: ContactForChat[];
	isLoading: boolean;
} {
	const result = useQuery(
		api.model.contacts.getContactForChat,
		chatId ? { chatId } : "skip",
	) as ContactForChat[] | undefined;
	return {
		contacts: result ?? [],
		isLoading: result === undefined,
	};
}
