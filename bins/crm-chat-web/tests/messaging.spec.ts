import { expect, test } from "./fixtures";
import {
	api,
	getCachedConvexUserId,
	getRobotClient,
	seedTestClient,
	type WorkerConfig,
} from "./helpers";

test.describe.configure({ mode: "serial" });

let workerCfg: WorkerConfig;

test.describe("Messaging", () => {
	test.beforeAll(({ workerBackend }) => {
		workerCfg = workerBackend;
	});

	test("queues an outgoing message from the chat composer", async ({
		page,
	}) => {
		const robot = await getRobotClient(workerCfg);
		const userId = getCachedConvexUserId();
		const clientId = await seedTestClient(
			userId,
			`telegram:messaging-${Date.now()}`,
			robot,
		);
		const chatId = `${clientId}:chat-pinned-1`;
		const messageText = `Composer send ${Date.now()}`;

		await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);
		await expect(page.getByRole("heading", { name: "Alice" })).toBeVisible({
			timeout: 10_000,
		});

		await page.getByPlaceholder("Write a message...").fill(messageText);
		await page.getByRole("button", { name: "Send message" }).click();

		await expect(page.getByPlaceholder("Write a message...")).toHaveValue("");
		await expect
			.poll(async () => {
				const rows = await robot.query(api.testHelpers.queryOutgoingMessages, {
					userId,
				});
				return rows.some(
					(row) => row.chatId === chatId && row.text === messageText,
				);
			})
			.toBe(true);

		await robot.mutation(api.testHelpers.deleteClient, { clientId });
	});
});
