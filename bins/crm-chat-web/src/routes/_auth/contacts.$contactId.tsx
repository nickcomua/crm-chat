import { createFileRoute } from "@tanstack/react-router";
import { ContactsPage } from "@/components/contacts-page";

interface ContactSearchParams {
	dialogId?: string;
	pinnedMessageId?: string;
}

export const Route = createFileRoute("/_auth/contacts/$contactId")({
	component: ContactsPage,
	validateSearch: (search: Record<string, unknown>): ContactSearchParams => ({
		dialogId: typeof search.dialogId === "string" ? search.dialogId : undefined,
		pinnedMessageId:
			typeof search.pinnedMessageId === "string"
				? search.pinnedMessageId
				: undefined,
	}),
});
