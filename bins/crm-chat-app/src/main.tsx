import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { SurrealProvider } from "./contexts/surreal-provider";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<SurrealProvider
				autoConnect
				endpoint={import.meta.env.VITE_SURREALDB_ENDPOINT}
				params={{
					database: "tg",
					namespace: "tg",
					auth: {
						username: import.meta.env.VITE_SURREAL_USERNAME,
						password: import.meta.env.VITE_SURREAL_PASSWORD,
					},
				}}
			>
				<App />
			</SurrealProvider>
		</QueryClientProvider>
	</StrictMode>
);
