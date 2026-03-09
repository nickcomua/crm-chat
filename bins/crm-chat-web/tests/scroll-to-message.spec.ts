import { expect, test } from "./fixtures";
import {
	api,
	getConvexUserId,
	getRobotClient,
	type Id,
	type WorkerConfig,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

// Run tests sequentially — they share seeded data.
test.describe.configure({ mode: "serial" });

let workerCfg: WorkerConfig;

test.describe("Scroll to Message", () => {
	let clientId: Id<"clients">;
	let chatId: string;
	let userId: string;
	// Target message in the first page (should scroll without loadMore).
	let firstPageTargetId: string;
	// Target message near the top of the list (oldest messages).
	let deepTargetId: string;

	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		userId = await getConvexUserId(page);
		const robot = getRobotClient(workerCfg);

		// Create test client.
		clientId = (await robot.mutation(api.clients.workerRegisterConnected, {
			userId,
			telegramId: `telegram:scroll-test-${Date.now()}`,
			kind: "Telegram",
		})) as Id<"clients">;

		// Create test chat.
		chatId = `${clientId}:scroll-chat`;
		await robot.mutation(api.testHelpers.seedChat, {
			chatId,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Scroll Test Chat",
			lastMessageTimestamp: Date.now(),
		});

		// Create 70 messages. PAGE_SIZE is currently 8000, so all 70 fit in one page.
		// To actually test loadMore, we'd need >8000 messages.
		const baseTs = Date.now() - 400_000;
		for (let i = 1; i <= 70; i++) {
			const msgId = `${clientId}:${chatId}:msg-${i}`;
			await robot.mutation(api.testHelpers.seedMessage, {
				messageId: msgId,
				externalId: `scroll-ext-${i}`,
				userId,
				clientId,
				chatId,
				senderId: "sender-1",
				text: `Test message number ${i}`,
				outgoing: i % 2 === 0,
				deleted: false,
				timestamp: baseTs + i * 5000,
			});
		}

		firstPageTargetId = `${clientId}:${chatId}:msg-60`;
		// With PAGE_SIZE=8000, msg-10 also loads in the first page. This test
		// still validates scroll-to-target but does NOT exercise loadMore.
		deepTargetId = `${clientId}:${chatId}:msg-10`;

		await context.close();
	});

	test("scrolls to a message in the first page", async ({ page }) => {
		await page.goto(
			`/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(firstPageTargetId)}`,
		);

		// The target message should become visible.
		const targetEl = page.locator(`[data-message-id="${firstPageTargetId}"]`);
		await expect(targetEl).toBeVisible({ timeout: 10_000 });
		await expect(targetEl).toContainText("Test message number 60");

		// Verified: message-list.tsx:173 — highlight uses "ring-2 ring-primary ring-offset-2"
		const bubble = targetEl.locator(".ring-primary");
		await expect(bubble).toBeVisible({ timeout: 5000 });
	});

	test("scrolls to an older message near the top", async ({ page }) => {
		await page.goto(
			`/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(deepTargetId)}`,
		);

		// With PAGE_SIZE=8000 all 70 messages are in the first page, so this
		// tests scroll-to-index but not loadMore pagination.
		const targetEl = page.locator(`[data-message-id="${deepTargetId}"]`);
		await expect(targetEl).toBeVisible({ timeout: 10_000 });
		await expect(targetEl).toContainText("Test message number 10");
	});

	test("navigating to chat without messageId scrolls to bottom", async ({
		page,
	}) => {
		await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

		// The newest message (70) should be visible at the bottom.
		const newestEl = page.locator(
			`[data-message-id="${clientId}:${chatId}:msg-70"]`,
		);
		await expect(newestEl).toBeVisible({ timeout: 10_000 });
		await expect(newestEl).toContainText("Test message number 70");
	});
});
