import { createFileRoute } from "@tanstack/react-router";
import { TelegramClientsManager } from "@/components/telegram-clients-manager";

export const Route = createFileRoute("/_auth/settings")({
	component: SettingsPage,
});

function SettingsPage(): React.ReactNode {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-4xl px-6 py-8">
				<TelegramClientsManager />
			</div>
		</div>
	);
}
