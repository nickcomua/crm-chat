import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: IndexPage,
});

function IndexPage(): React.ReactNode {
	// No auth - redirect directly to chats
	return <Navigate to="/chats" />;
}
