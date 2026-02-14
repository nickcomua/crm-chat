import { createFileRoute } from "@tanstack/react-router";
import { ClientSettings } from "@/components/client-settings";

export const Route = createFileRoute("/_auth/client/$clientId")({
  component: ClientSettingsPage,
});

function ClientSettingsPage(): React.ReactNode {
  const { clientId } = Route.useParams();

  return (
    <div className="h-full overflow-y-auto">
      <div className="container px-4 py-8">
        <ClientSettings clientId={clientId} />
      </div>
    </div>
  );
}
