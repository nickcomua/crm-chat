import { defineConfig, devices } from "@playwright/test";
import { env } from "./tests/env";

export default defineConfig({
	testDir: "./tests",
	fullyParallel: true,
	forbidOnly: !!env.CI,
	retries: env.CI ? 2 : 0,
	workers: 1,
	reporter: "html",
	timeout: 30_000,
	globalTeardown: "./tests/global-teardown.ts",
	use: {
		baseURL: env.TEST_BASE_URL,
		trace: "on-first-retry",
	},
	projects: [
		{ name: "setup", testMatch: /auth\.setup\.ts/ },
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/.auth/user.json",
			},
			dependencies: ["setup"],
			testIgnore: [
				/e2e-telegram\/scan-chats\.spec/,
				/e2e-telegram\/media-rendering\.spec/,
				/e2e-telegram\/media-visual\.spec/,
				/e2e-telegram\/qr-auth\.spec/,
				/e2e-telegram\/qr-auth-real\.spec/,
				/e2e-telegram\/replies-real\.spec/,
			],
		},
		// Real-TG specs run sequentially via dependency chain.
		// The worker has limited task processing capacity — parallel specs
		// that create worker tasks (QR auth, ChatScanner) compete for resources,
		// causing ChatScanner to stall during message fetching.
		{
			name: "tg-scan",
			testMatch: /e2e-telegram\/scan-chats\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/.auth/user.json",
			},
			dependencies: ["setup"],
		},
		{
			name: "tg-qr-auth",
			testMatch: /e2e-telegram\/qr-auth\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/.auth/user.json",
			},
			dependencies: ["tg-scan"],
		},
		{
			name: "tg-qr-auth-real",
			testMatch: /e2e-telegram\/qr-auth-real\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/.auth/user.json",
			},
			dependencies: ["tg-qr-auth"],
		},
		{
			name: "tg-media-render",
			testMatch: /e2e-telegram\/media-rendering\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/.auth/user.json",
			},
			dependencies: ["tg-qr-auth-real"],
		},
		{
			name: "tg-media-visual",
			testMatch: /e2e-telegram\/media-visual\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/.auth/user.json",
			},
			dependencies: ["tg-media-render"],
		},
		// Real-TG: verifies that two manually-seeded messages (one plain reply,
		// one "Quote this part" reply) in the test account scan, render a
		// preview in the chat view, and navigate to the parent on click.
		{
			name: "tg-replies-real",
			testMatch: /e2e-telegram\/replies-real\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/.auth/user.json",
			},
			dependencies: ["tg-media-visual"],
		},
	],
});
