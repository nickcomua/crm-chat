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

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let chatId: string;
let workerCfg: WorkerConfig;

test.describe("Forwarded Messages — Backend", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const robot = await getRobotClient(workerCfg);
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		userId = await getConvexUserId(page);
		clientId = await seedTestClient(
			userId,
			`telegram:fwd-test-${Date.now()}`,
			robot,
		);
		chatId = `${clientId}:fwd-chat`;

		await robot.mutation(api.testHelpers.seedChat, {
			chatId,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Forward Test",
			lastMessageTimestamp: Date.now(),
		});

		await context.close();
	});

	test("stores forwardedFrom on a message", async () => {
		const robot = await getRobotClient(workerCfg);
		const msgId = `${chatId}:msg-fwd-1`;
		await seedMessage(
			userId,
			clientId,
			chatId,
			msgId,
			"Forwarded content",
			robot,
			{
				forwardedFrom: {
					senderName: "Alice Wonderland",
					date: 1_700_000_000_000,
				},
			},
		);

		const msgs = (await robot.query(api.testHelpers.queryMessages, {
			chatId,
			limit: 10,
		})) as Array<{
			messageId: string;
			forwardedFrom?: { senderName: string; date?: number };
		}>;

		const msg = msgs.find((m) => m.messageId === msgId);
		expect(msg).toBeTruthy();
		expect(msg?.forwardedFrom).toBeTruthy();
		expect(msg?.forwardedFrom?.senderName).toBe("Alice Wonderland");
		expect(msg?.forwardedFrom?.date).toBe(1_700_000_000_000);
	});

	test("forwardedFrom without date stores senderName only", async () => {
		const robot = await getRobotClient(workerCfg);
		const msgId = `${chatId}:msg-fwd-nodate`;
		await seedMessage(
			userId,
			clientId,
			chatId,
			msgId,
			"Forwarded, no date",
			robot,
			{
				forwardedFrom: { senderName: "Bob" },
			},
		);

		const msgs = (await robot.query(api.testHelpers.queryMessages, {
			chatId,
			limit: 10,
		})) as Array<{
			messageId: string;
			forwardedFrom?: { senderName: string; date?: number };
		}>;

		const msg = msgs.find((m) => m.messageId === msgId);
		expect(msg?.forwardedFrom?.senderName).toBe("Bob");
		expect(msg?.forwardedFrom?.date).toBeUndefined();
	});

	test("normal message has no forwardedFrom", async () => {
		const robot = await getRobotClient(workerCfg);
		const msgId = `${chatId}:msg-normal`;
		await seedMessage(userId, clientId, chatId, msgId, "Not forwarded", robot);

		const msgs = (await robot.query(api.testHelpers.queryMessages, {
			chatId,
			limit: 10,
		})) as Array<{ messageId: string; forwardedFrom?: unknown }>;

		const msg = msgs.find((m) => m.messageId === msgId);
		expect(msg).toBeTruthy();
		expect(msg?.forwardedFrom).toBeUndefined();
	});
});

test.describe("Forwarded Messages — UI", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		workerCfg = workerBackend;
		const robot = await getRobotClient(workerCfg);
		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });

		userId = await getConvexUserId(page);
		clientId = await seedTestClient(
			userId,
			`telegram:fwd-ui-${Date.now()}`,
			robot,
		);
		chatId = `${clientId}:fwd-ui-chat`;

		await robot.mutation(api.testHelpers.seedChat, {
			chatId,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Forward UI Test",
			lastMessageTimestamp: Date.now(),
		});

		await seedMessage(
			userId,
			clientId,
			chatId,
			`${chatId}:ui-fwd`,
			"Check out this message!",
			robot,
			{
				forwardedFrom: {
					senderName: "Alice Wonderland",
					date: 1_700_000_000_000,
				},
				timestamp: Date.now(),
			},
		);

		await seedMessage(
			userId,
			clientId,
			chatId,
			`${chatId}:ui-normal`,
			"Just a normal message",
			robot,
			{
				timestamp: Date.now() - 1000,
			},
		);

		await context.close();
	});

	test("renders 'Forwarded from' header on forwarded message", async ({
		page,
	}) => {
		await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

		const fwdMsg = page.locator(`[data-message-id="${chatId}:ui-fwd"]`);
		await expect(fwdMsg).toBeVisible({ timeout: 10_000 });

		// Verified: message-list.tsx:188 — data-testid="forwarded-from"
		const fwdHeader = fwdMsg.locator('[data-testid="forwarded-from"]');
		await expect(fwdHeader).toBeVisible({ timeout: 5000 });
		await expect(fwdHeader).toContainText("Alice Wonderland");
	});

	test("normal message has no forwarded header", async ({ page }) => {
		await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);

		const normalMsg = page.locator(`[data-message-id="${chatId}:ui-normal"]`);
		await expect(normalMsg).toBeVisible({ timeout: 10_000 });

		const fwdHeader = normalMsg.locator('[data-testid="forwarded-from"]');
		await expect(fwdHeader).toHaveCount(0);
	});
});
