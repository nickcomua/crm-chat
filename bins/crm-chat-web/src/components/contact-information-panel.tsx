import type { Id } from "@/lib/convex";
import { ContactActivityBoard } from "./contact-activity-board";
import { ContactFactsPanel } from "./contact-facts-panel";

interface ContactInformationPanelProps {
	contactId: Id<"contacts">;
}

export function ContactInformationPanel({
	contactId,
}: ContactInformationPanelProps): React.ReactNode {
	return (
		<div className="space-y-4">
			<ContactFactsPanel contactId={contactId} />
			<ContactActivityBoard contactId={contactId} />
		</div>
	);
}
