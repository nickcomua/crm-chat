import { expect, test } from "./fixtures";
import {
	api,
	getConvexUserId,
	getRobotClient,
	type Id,
	seedMessage,
	seedTestClient,
	type WorkerConfig,
} from "./helpers";

/**
 * Search Tests — TDD for Convex-native full-text search
 *
 * Uses Convex's built-in searchIndex on the messages table.
 * 1. Backend: Verify seeded messages are stored correctly (data integrity)
 * 2. Backend: Verify Convex full-text search returns correct results
 * 3. UI: Search dialog tests (waiting for Convex search to be wired into UI)
 */

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let chatId: string;
let workerCfg: WorkerConfig;

test.describe("Search — Backend (Data Integrity)", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		userId = await getConvexUserId(page);
		const robot = await getRobotClient(workerCfg);
		clientId = await seedTestClient(
			userId,
			`telegram:search-test-${Date.now()}`,
			robot,
		);
		chatId = `${clientId}:search-chat`;

		await robot.mutation(api.testHelpers.seedChat, {
			chatId,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Search Test Chat",
			lastMessageTimestamp: Date.now(),
		});

		await context.close();
	});

	test("seeded messages with known text are stored correctly", async () => {
		const robot = await getRobotClient(workerCfg);
		const msg1Id = `${chatId}:search-msg-1`;
		const msg2Id = `${chatId}:search-msg-2`;
		const msg3Id = `${chatId}:search-msg-3`;

		await seedMessage(
			userId,
			clientId,
			chatId,
			msg1Id,
			"Meeting with John about project alpha",
			robot,
		);
		await seedMessage(
			userId,
			clientId,
			chatId,
			msg2Id,
			"Quarterly budget review scheduled",
			robot,
		);
		await seedMessage(
			userId,
			clientId,
			chatId,
			msg3Id,
			"Don't forget to send the invoice",
			robot,
		);

		// Verify messages were stored via Convex query
		const msgs = (await robot.query(api.testHelpers.queryMessages, {
			chatId,
			limit: 10,
		})) as Array<{ messageId: string; text?: string }>;

		const msg1 = msgs.find((m) => m.messageId === msg1Id);
		const msg2 = msgs.find((m) => m.messageId === msg2Id);
		const msg3 = msgs.find((m) => m.messageId === msg3Id);

		expect(msg1?.text).toBe("Meeting with John about project alpha");
		expect(msg2?.text).toBe("Quarterly budget review scheduled");
		expect(msg3?.text).toBe("Don't forget to send the invoice");
	});

	test("messages with empty text are stored as undefined", async () => {
		const robot = await getRobotClient(workerCfg);
		const msgId = `${chatId}:search-empty-text`;
		await seedMessage(userId, clientId, chatId, msgId, undefined, robot);

		const msgs = (await robot.query(api.testHelpers.queryMessages, {
			chatId,
			limit: 10,
		})) as Array<{ messageId: string; text?: string }>;

		const msg = msgs.find((m) => m.messageId === msgId);
		expect(msg).toBeTruthy();
		expect(msg?.text).toBeUndefined();
	});
});

test.describe("Search — Convex Full-Text", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		userId = await getConvexUserId(page);
		const robot = await getRobotClient(workerCfg);
		clientId = await seedTestClient(
			userId,
			`telegram:search-ft-${Date.now()}`,
			robot,
		);
		chatId = `${clientId}:search-ft-chat`;

		await robot.mutation(api.testHelpers.seedChat, {
			chatId,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Full-Text Search Chat",
			lastMessageTimestamp: Date.now(),
		});

		// Seed messages with distinctive text for search matching
		await seedMessage(
			userId,
			clientId,
			chatId,
			`${chatId}:ft-msg-1`,
			"Discussing the quarterly revenue forecast with finance team",
			robot,
		);
		await seedMessage(
			userId,
			clientId,
			chatId,
			`${chatId}:ft-msg-2`,
			"Please review the contract draft before Thursday",
			robot,
		);
		await seedMessage(
			userId,
			clientId,
			chatId,
			`${chatId}:ft-msg-3`,
			"Reminder about the quarterly board meeting next week",
			robot,
		);
		await seedMessage(
			userId,
			clientId,
			chatId,
			`${chatId}:ft-msg-4`,
			"Updated the project timeline in the shared document",
			robot,
		);

		await context.close();
	});

	test("search returns messages matching a keyword", async () => {
		const robot = await getRobotClient(workerCfg);
		const results = (await robot.query(api.testHelpers.searchMessages, {
			searchText: "quarterly",
			userId,
		})) as Array<{ messageId: string; text?: string }>;

		// Should find the two messages containing "quarterly"
		const matchingTexts = results.map((r) => r.text);
		expect(matchingTexts.some((t) => t?.includes("quarterly revenue"))).toBe(
			true,
		);
		expect(matchingTexts.some((t) => t?.includes("quarterly board"))).toBe(
			true,
		);
	});

	test("search scoped to a chat only returns messages from that chat", async () => {
		const robot = await getRobotClient(workerCfg);

		// Create a second chat with a message containing the same keyword
		const chatId2 = `${clientId}:search-ft-chat-2`;
		await robot.mutation(api.testHelpers.seedChat, {
			chatId: chatId2,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: false,
			pinnedName: "Other Chat",
			lastMessageTimestamp: Date.now(),
		});
		await seedMessage(
			userId,
			clientId,
			chatId2,
			`${chatId2}:ft-msg-other`,
			"The quarterly report is ready",
			robot,
		);

		// Search scoped to original chat
		const scopedResults = (await robot.query(api.testHelpers.searchMessages, {
			searchText: "quarterly",
			userId,
			chatId,
		})) as Array<{ messageId: string; chatId: string; text?: string }>;

		// All results should be from the scoped chat
		for (const r of scopedResults) {
			expect(r.chatId).toBe(chatId);
		}
		// Should NOT include the message from chatId2
		expect(scopedResults.some((r) => r.text?.includes("report is ready"))).toBe(
			false,
		);
	});

	test("search with no matching text returns empty results", async () => {
		const robot = await getRobotClient(workerCfg);
		const results = (await robot.query(api.testHelpers.searchMessages, {
			searchText: "xyznonexistentkeyword",
			userId,
		})) as Array<{ messageId: string }>;

		expect(results).toHaveLength(0);
	});

	test("search respects limit parameter", async () => {
		const robot = await getRobotClient(workerCfg);
		const results = (await robot.query(api.testHelpers.searchMessages, {
			searchText: "quarterly",
			userId,
			limit: 1,
		})) as Array<{ messageId: string }>;

		expect(results.length).toBeLessThanOrEqual(1);
	});
});

// TODO: Re-enable once Convex search is wired into the UI (replacing the old ES proxy path).
// These tests verify the search dialog shell works — they'll pass once use-search.ts
// calls Convex full-text search instead of the removed ES proxy.
test.describe("Search — UI (Dialog Shell)", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		userId = await getConvexUserId(page);
		const robot = await getRobotClient(workerCfg);
		clientId = await seedTestClient(
			userId,
			`telegram:search-ui-${Date.now()}`,
			robot,
		);

		await context.close();
	});

	// Waiting for Convex search: dialog should open and show title
	test("search button opens search dialog", async ({ page }) => {
		await page.goto("/#/chats");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		const searchButton = page.locator(
			'button:has(span:text("Search messages"))',
		);
		await expect(searchButton).toBeVisible({ timeout: 10_000 });
		await searchButton.click();

		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog.locator("text=Search Messages")).toBeVisible();
	});

	// Waiting for Convex search: input should auto-focus and accept queries
	test("search input is auto-focused and accepts text", async ({ page }) => {
		await page.goto("/#/chats");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		const searchButton = page.locator(
			'button:has(span:text("Search messages"))',
		);
		await searchButton.click();

		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });

		const input = dialog.locator('input[type="search"]');
		await expect(input).toBeVisible();

		await input.fill("test query");
		await expect(input).toHaveValue("test query");
	});

	// Waiting for Convex search: scope buttons should render with default selection
	test("scope buttons render with 'All messages' default", async ({ page }) => {
		await page.goto("/#/chats");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		const searchButton = page.locator(
			'button:has(span:text("Search messages"))',
		);
		await searchButton.click();

		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });

		await expect(
			dialog.locator('button:has-text("All messages")'),
		).toBeVisible();
	});

	// Waiting for Convex search: Escape should dismiss the search dialog
	test("Escape closes search dialog", async ({ page }) => {
		await page.goto("/#/chats");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		const searchButton = page.locator(
			'button:has(span:text("Search messages"))',
		);
		await searchButton.click();

		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden({ timeout: 5000 });
	});
});
