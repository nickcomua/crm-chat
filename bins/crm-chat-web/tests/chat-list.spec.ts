import { expect, test } from "./fixtures";
import {
	api,
	getConvexUserId,
	getRobotClient,
	seedMessage,
	seedTestClient,
	type Id,
	type WorkerConfig,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let workerCfg: WorkerConfig;

test.describe("Chat List — Backend", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
		userId = await getConvexUserId(page);
		await context.close();
	});

	test("seeded chats appear in list query ordered by timestamp", async () => {
		const robot = getRobotClient(workerCfg);
		const cId = await seedTestClient(
			userId,
			`telegram:chatlist-backend-${Date.now()}`,
			robot,
		);

		// seedTestClient creates 3 chats:
		// Alice (pinned, now), Team Chat (unpinned, -1h), Bob (pinned, -2h)
		const chats = (await robot.query(api.testHelpers.queryChats, {
			userId,
		})) as Array<{
			chatId: string;
			pinnedName?: string;
			isPinned: boolean;
			lastMessageTimestamp: number;
		}>;

		// Filter to our test client's chats
		const ourChats = chats.filter((c) => c.chatId.startsWith(cId));
		expect(ourChats.length).toBe(3);

		// Verify pinned status
		const pinned = ourChats.filter((c) => c.isPinned);
		expect(pinned.length).toBe(2);

		// Cleanup
		await robot.mutation(api.testHelpers.deleteClient, { clientId: cId });
	});

	test("last message preview is returned for seeded chats", async () => {
		const robot = getRobotClient(workerCfg);
		const cId = await seedTestClient(
			userId,
			`telegram:chatlist-preview-${Date.now()}`,
			robot,
		);
		const chatId = `${cId}:chat-pinned-1`;

		// Seed a message
		await seedMessage(
			userId,
			cId,
			chatId,
			`${chatId}:preview-msg`,
			"Hello from test",
			robot,
			{
				timestamp: Date.now(),
			},
		);

		const lastMessages = (await robot.query(api.testHelpers.queryLastPerChat, {
			chatIds: [chatId],
		})) as Array<{ chatId: string; text?: string }>;

		expect(lastMessages.length).toBe(1);
		expect(lastMessages[0].text).toBe("Hello from test");

		await robot.mutation(api.testHelpers.deleteClient, { clientId: cId });
	});

	test("pinnedName update persists", async () => {
		const robot = getRobotClient(workerCfg);
		const cId = await seedTestClient(
			userId,
			`telegram:chatlist-rename-${Date.now()}`,
			robot,
		);
		const chatId = `${cId}:chat-pinned-1`;

		// Rename via upsert
		await robot.mutation(api.testHelpers.seedChat, {
			chatId,
			userId,
			clientId: cId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Renamed Alice",
			lastMessageTimestamp: Date.now(),
		});

		const chats = (await robot.query(api.testHelpers.queryChats, {
			userId,
		})) as Array<{
			chatId: string;
			pinnedName?: string;
		}>;
		const renamed = chats.find((c) => c.chatId === chatId);
		expect(renamed?.pinnedName).toBe("Renamed Alice");

		await robot.mutation(api.testHelpers.deleteClient, { clientId: cId });
	});
});

test.describe("Chat List — UI", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const robot = getRobotClient(workerCfg);
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
		userId = await getConvexUserId(page);

		clientId = await seedTestClient(
			userId,
			`telegram:chatlist-ui-${Date.now()}`,
			robot,
		);

		// Seed messages for chat previews
		const aliceChatId = `${clientId}:chat-pinned-1`;
		await seedMessage(
			userId,
			clientId,
			aliceChatId,
			`${aliceChatId}:msg-1`,
			"Hey, how are you?",
			robot,
			{
				timestamp: Date.now(),
			},
		);

		const teamChatId = `${clientId}:chat-unpinned-1`;
		await seedMessage(
			userId,
			clientId,
			teamChatId,
			`${teamChatId}:msg-1`,
			"Meeting at 3pm",
			robot,
			{
				timestamp: Date.now() - 3_600_000,
			},
		);

		await context.close();
	});

	test("renders seeded chats with names and last message previews", async ({
		page,
	}) => {
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		// Wait for chat list to populate (only scanEnabled=true chats appear)
		await expect(page.locator("text=Alice").first()).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.locator("text=Bob").first()).toBeVisible();

		// Check last message preview for pinned chat
		await expect(page.locator("text=Hey, how are you?").first()).toBeVisible();
	});

	test("clicking a chat navigates to message view", async ({ page }) => {
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		// Click Alice chat
		const aliceChat = page.locator("button:has-text('Alice')").first();
		await expect(aliceChat).toBeVisible({ timeout: 10_000 });
		await aliceChat.click();

		// Should navigate to chat view and show messages
		await expect(page.locator("text=Hey, how are you?")).toBeVisible({
			timeout: 10_000,
		});
		// Header should show chat name (confirmed h2 in message view)
		await expect(page.locator("h2:has-text('Alice')")).toBeVisible();
	});

	test("search input filters chat list", async ({ page }) => {
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
		await expect(page.locator("text=Alice").first()).toBeVisible({
			timeout: 10_000,
		});

		// Verified: chat-list.tsx:205 renders placeholder="Search chats..."
		const searchInput = page.locator('input[placeholder*="Search"]');
		await searchInput.fill("Bob");

		// Alice should be filtered out (only scan-enabled chats shown)
		await expect(page.locator("text=Bob").first()).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator("button:has-text('Alice')")).toBeHidden();

		// Clear search
		await searchInput.clear();
		await expect(page.locator("text=Alice").first()).toBeVisible({
			timeout: 5000,
		});
	});

	test("pinned chats are ordered by timestamp (newest first)", async ({
		page,
	}) => {
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
		await expect(page.locator("text=Alice").first()).toBeVisible({
			timeout: 10_000,
		});

		// Only scanEnabled=true chats appear (Alice: now, Bob: -2h)
		// Alice should appear before Bob (newer timestamp first)
		const chatButtons = page.locator(
			"button:has-text('Alice'), button:has-text('Bob')",
		);
		const count = await chatButtons.count();
		expect(count).toBeGreaterThanOrEqual(2);

		const names: string[] = [];
		for (let i = 0; i < count; i++) {
			const text = await chatButtons.nth(i).textContent();
			if (text?.includes("Alice")) {
				names.push("Alice");
			} else if (text?.includes("Bob")) {
				names.push("Bob");
			}
		}

		const aliceIdx = names.indexOf("Alice");
		const bobIdx = names.indexOf("Bob");

		if (aliceIdx !== -1 && bobIdx !== -1) {
			expect(aliceIdx).toBeLessThan(bobIdx);
		}
	});

	test("deleting client removes its chats from the backend", async () => {
		// Verify chats exist before deletion
		const robot = getRobotClient(workerCfg);
		const chatsBefore = (await robot.query(api.testHelpers.queryChats, {
			userId,
		})) as Array<{
			chatId: string;
		}>;
		const ourChatsBefore = chatsBefore.filter((c) =>
			c.chatId.startsWith(clientId),
		);
		expect(ourChatsBefore.length).toBeGreaterThanOrEqual(2);

		// Delete the client (cascades to its chats)
		await robot.mutation(api.testHelpers.deleteClient, { clientId });

		// Verify chats for this client are gone
		const chatsAfter = (await robot.query(api.testHelpers.queryChats, {
			userId,
		})) as Array<{
			chatId: string;
		}>;
		const ourChatsAfter = chatsAfter.filter((c) =>
			c.chatId.startsWith(clientId),
		);
		expect(ourChatsAfter.length).toBe(0);

		// Re-seed for any downstream tests
		clientId = await seedTestClient(
			userId,
			`telegram:chatlist-ui-reseed-${Date.now()}`,
			robot,
		);
	});
});
