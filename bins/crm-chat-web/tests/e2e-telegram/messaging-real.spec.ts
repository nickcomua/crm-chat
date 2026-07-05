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

const CHATS_URL_PATTERN = /\/#\/chats/;

test.describe.configure({ mode: "serial" });

let workerCfg: WorkerConfig;
let userId: string;
let clientId: Id<"clients">;
let savedMessagesChatId: string;

test.describe("Real Telegram messaging", () => {
	test.beforeAll(async ({ browser, workerBackend }) => {
		test.setTimeout(90_000);
		workerCfg = workerBackend;

		const context = await browser.newContext({
			storageState: "tests/.auth/user.json",
		});
		const page = await context.newPage();
		await page.goto("/");
		await page.waitForURL(CHATS_URL_PATTERN, { timeout: 10_000 });
		userId = await getConvexUserId(page);

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

		savedMessagesChatId = `${clientId}:${env.TG_USER_ID_1}`;
		await robot.mutation(api.testHelpers.seedChat, {
			chatId: savedMessagesChatId,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Saved Messages",
			lastMessageTimestamp: Date.now(),
		});

		await context.close();
	});

	test("sends a message to saved messages from the chat composer", async ({
		page,
	}) => {
		test.setTimeout(90_000);
		const robot = await getRobotClient(workerCfg);
		const messageText = `Playwright real send ${Date.now()}`;

		await page.goto(`/#/chats/${encodeURIComponent(savedMessagesChatId)}`);
		await expect(page.getByPlaceholder("Write a message...")).toBeVisible({
			timeout: 15_000,
		});

		await page.getByPlaceholder("Write a message...").fill(messageText);
		await page.getByRole("button", { name: "Send message" }).click();

		await expect(page.getByPlaceholder("Write a message...")).toHaveValue("");

		await pollUntil(
			page,
			async () => {
				const rows = (await robot.query(api.testHelpers.queryOutgoingMessages, {
					userId,
				})) as Array<{
					chatId: string;
					text: string;
					status: string;
					externalMessageId?: string;
				}>;
				return rows.some(
					(row) =>
						row.chatId === savedMessagesChatId &&
						row.text === messageText &&
						row.status === "Sent" &&
						typeof row.externalMessageId === "string" &&
						row.externalMessageId.length > 0,
				);
			},
			500,
			60_000,
		);

		await expect(
			page.getByText(messageText, { exact: true }).last(),
		).toBeVisible({
			timeout: 15_000,
		});

		const messages = (await robot.query(api.testHelpers.queryMessages, {
			chatId: savedMessagesChatId,
			limit: 20,
		})) as Array<{
			text?: string;
			outgoing: boolean;
		}>;
		expect(messages.map((message) => message.text)).toContain(messageText);
	});
});
