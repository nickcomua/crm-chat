import { createFileRoute } from "@tanstack/react-router";
import { DownloadManager } from "@/components/download-manager";

export const Route = createFileRoute("/_auth/downloads")({
	component: DownloadsPage,
});

function DownloadsPage(): React.ReactNode {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-4xl px-6 py-8">
				<DownloadManager />
			</div>
		</div>
	);
}
