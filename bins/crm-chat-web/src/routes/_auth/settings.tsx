import { createFileRoute } from "@tanstack/react-router";
import { TelegramClientsManager } from "@/components/telegram-clients-manager";

export const Route = createFileRoute("/_auth/settings")({
  component: SettingsPage,
});

function SettingsPage(): React.ReactNode {
  return (
    <div className="container px-4 py-8">
      <TelegramClientsManager />
    </div>
  );
}
