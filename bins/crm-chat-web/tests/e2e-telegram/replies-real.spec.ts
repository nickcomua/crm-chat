import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { env } from "../env";
import { expect, test } from "../fixtures";
import {
	api,
	getConvexUserId,
	getRobotClient,
	getSessionPath,
	type Id,
	pollUntil,
	type WorkerConfig,
	writeOwnerFile,
} from "../helpers";

// Real-TG spec: the test account has two manually-sent messages in some chat
// — one plain reply (no quote) and one "quote this part" reply. After
// scanning, the plain reply should have `replyToMessageId` set but no stored
// `replyToText`, while the quote reply should have both. The UI must render
// a preview for each (plain via server-side parent lookup, quote via the
// stored fragment) and clicking a preview must scroll/highlight the parent.

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

interface ReplyRow {
	chatId: string;
	messageId: string;
	replyToMessageId?: string;
	replyToText?: string;
	text?: string;
}

let workerCfg: WorkerConfig;
let userId: string;
let clientId: Id<"clients">;
// Chat containing both reply shapes (discovered dynamically).
let chatId: string;
let plainReply: ReplyRow;
let quoteReply: ReplyRow;

test.describe("Real Telegram — plain reply + quote reply", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		// Scanning + polling for the seeded replies can take a few minutes.
		test.setTimeout(300_000);
		workerCfg = workerBackend;

		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
		userId = await getConvexUserId(page);

		// Copy the real session into place and register the TG client.
		const telegramId = `telegram:${env.TG_USER_ID_1}`;
		const sessionPath = getSessionPath(
			telegramId,
			userId,
			workerCfg.sessionDir,
		);
		mkdirSync(path.dirname(sessionPath), { recursive: true });
		copyFileSync(env.TG_SESSION_FILE_1, sessionPath);
		writeOwnerFile(sessionPath, userId);

		const robot = await getRobotClient(workerCfg);
		clientId = (await robot.mutation(
			api.model.clients.workerRegisterConnected,
			{ userId, telegramId, kind: "Telegram" },
		)) as Id<"clients">;

		// Enable scanning on every chat — we don't know which one holds the
		// hand-seeded replies, so cast a wide net.
		await page.goto(`/#/client/${clientId}`);
		await page.waitForSelector("text=Chat Scanning", { timeout: 10_000 });
		const toggles = page.locator('button[aria-label^="Toggle scanning for"]');
		await expect(toggles.first()).toBeVisible({ timeout: 30_000 });
		const toggleCount = await toggles.count();
		for (let i = 0; i < toggleCount; i++) {
			if ((await toggles.nth(i).getAttribute("aria-checked")) !== "true") {
				await toggles.nth(i).click();
			}
		}

		// Poll the DB until we've found both reply shapes somewhere. The chat
		// scanner runs asynchronously; give it up to ~3 minutes to ingest
		// everything and hit the messages with reply headers.
		await pollUntil(
			page,
			async () => {
				const chats = (await robot.query(api.testHelpers.queryChats, {
					userId,
				})) as Array<{ chatId: string; clientId: string }>;
				for (const c of chats.filter((ch) => ch.clientId === clientId)) {
					const msgs = (await robot.query(api.testHelpers.queryMessages, {
						chatId: c.chatId,
						limit: 500,
					})) as ReplyRow[];
					const plain = msgs.find((m) => m.replyToMessageId && !m.replyToText);
					const quote = msgs.find((m) => m.replyToMessageId && m.replyToText);
					if (plain && quote && plain.messageId !== quote.messageId) {
						chatId = c.chatId;
						plainReply = { ...plain, chatId: c.chatId };
						quoteReply = { ...quote, chatId: c.chatId };
						return true;
					}
				}
				return false;
			},
			3000,
			180_000,
		);

		await context.close();
	});

	test("plain reply stores replyToMessageId with no replyToText (storage)", () => {
		expect(plainReply.replyToMessageId).toBeTruthy();
		expect(plainReply.replyToText).toBeUndefined();
	});

	test("quote reply stores both replyToMessageId and replyToText (storage)", () => {
		expect(quoteReply.replyToMessageId).toBeTruthy();
		expect(quoteReply.replyToText).toBeTruthy();
		expect((quoteReply.replyToText ?? "").length).toBeGreaterThan(0);
	});

	test("UI renders preview for plain reply (parent text via server lookup)", async ({
		page,
	}) => {
		await page.goto(
			`/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(plainReply.messageId)}`,
		);
		const bubble = page.locator(`[data-message-id="${plainReply.messageId}"]`);
		await expect(bubble).toBeVisible({ timeout: 20_000 });
		const preview = bubble.locator('[data-testid="reply-preview"]');
		await expect(preview).toBeVisible({ timeout: 10_000 });
		// Preview should show the parent message's text (fetched server-side).
		const parentText = await getParentText(plainReply.replyToMessageId);
		if (parentText) {
			await expect(preview).toContainText(parentText.slice(0, 40));
		}
	});

	test("UI renders preview for quote reply (stored quote fragment)", async ({
		page,
	}) => {
		await page.goto(
			`/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(quoteReply.messageId)}`,
		);
		const bubble = page.locator(`[data-message-id="${quoteReply.messageId}"]`);
		await expect(bubble).toBeVisible({ timeout: 20_000 });
		const preview = bubble.locator('[data-testid="reply-preview"]');
		await expect(preview).toBeVisible({ timeout: 10_000 });
		await expect(preview).toContainText(
			(quoteReply.replyToText ?? "").slice(0, 40),
		);
	});

	test("clicking plain-reply preview scrolls to and highlights parent", async ({
		page,
	}) => {
		await page.goto(
			`/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(plainReply.messageId)}`,
		);
		const bubble = page.locator(`[data-message-id="${plainReply.messageId}"]`);
		await expect(bubble).toBeVisible({ timeout: 20_000 });
		await bubble.locator('[data-testid="reply-preview"]').click();

		const parent = page.locator(
			`[data-message-id="${plainReply.replyToMessageId}"]`,
		);
		await expect(parent).toBeVisible({ timeout: 10_000 });
		await expect(parent.locator(".ring-primary")).toBeVisible({
			timeout: 5000,
		});
	});

	test("clicking quote-reply preview scrolls to and highlights parent", async ({
		page,
	}) => {
		await page.goto(
			`/#/chats/${encodeURIComponent(chatId)}?messageId=${encodeURIComponent(quoteReply.messageId)}`,
		);
		const bubble = page.locator(`[data-message-id="${quoteReply.messageId}"]`);
		await expect(bubble).toBeVisible({ timeout: 20_000 });
		await bubble.locator('[data-testid="reply-preview"]').click();

		const parent = page.locator(
			`[data-message-id="${quoteReply.replyToMessageId}"]`,
		);
		await expect(parent).toBeVisible({ timeout: 10_000 });
		await expect(parent.locator(".ring-primary")).toBeVisible({
			timeout: 5000,
		});
	});
});

async function getParentText(
	messageId: string | undefined,
): Promise<string | undefined> {
	if (!messageId) {
		return;
	}
	const robot = await getRobotClient(workerCfg);
	const msgs = (await robot.query(api.testHelpers.queryMessages, {
		chatId,
		limit: 500,
	})) as Array<{ messageId: string; text?: string }>;
	return msgs.find((m) => m.messageId === messageId)?.text;
}
