/* eslint-disable @typescript-eslint/no-empty-object-type */
/** biome-ignore-all lint/complexity/noBannedTypes: should be like this({}) its playwright rules */
/* eslint-disable no-empty-pattern */
/** biome-ignore-all lint/correctness/noEmptyPattern: should be like this({}) its playwright rules */
import { test as base } from "@playwright/test";
import { env } from "./env";

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------
interface WorkerFixtures {
	workerBackend: {
		convexUrl: string;
		m2mSecretKey: string;
		sessionDir: string;
		baseURL: string;
	};
}

// ---------------------------------------------------------------------------
// Worker-scoped fixture — connects to the services already running under
// `devenv up`. No workspace creation, no process orchestration.
// ---------------------------------------------------------------------------
export const test = base.extend<{}, WorkerFixtures>({
	workerBackend: [
		async ({}, use) => {
			await use({
				convexUrl: env.VITE_CONVEX_URL,
				m2mSecretKey: env.CLERK_M2M_SECRET_KEY,
				sessionDir: env.TG_SESSION_DIR ?? "./target/crm-worker-data",
				baseURL: env.TEST_BASE_URL,
			});
		},
		{ scope: "worker", timeout: 30_000 },
	],
});

export { expect } from "@playwright/test";
