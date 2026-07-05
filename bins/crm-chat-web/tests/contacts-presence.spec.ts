import { expect, test } from "./fixtures";
import {
	api,
	getCachedConvexUserId,
	getRobotClient,
	type Id,
	seedTestClient,
	type WorkerConfig,
} from "./helpers";

test.describe.configure({ mode: "serial" });

let workerCfg: WorkerConfig;

test.describe("Contacts — presence", () => {
	test.beforeAll(async ({ workerBackend }) => {
		workerCfg = workerBackend;
	});

	test("shows an online indicator when a linked Telegram sender is online", async ({
		page,
	}) => {
		const robot = await getRobotClient(workerCfg);
		const userId = getCachedConvexUserId();
		const displayName = `Online Contact ${Date.now()}`;
		const clientId = await seedTestClient(
			userId,
			`telegram:contacts-presence-${Date.now()}`,
			robot,
		);
		const contactId = (await robot.mutation(api.testHelpers.insertTestContact, {
			userId,
			displayName,
		})) as Id<"contacts">;
		await robot.mutation(api.testHelpers.insertTestChatContactLink, {
			userId,
			chatId: "presence-chat",
			senderId: "presence-sender",
			contactId,
		});
		await robot.mutation(api.model.contactPresence.workerRecordStatus, {
			userId,
			clientId,
			senderId: "presence-sender",
			status: "online",
			observedAt: Date.now(),
			expiresAt: Date.now() + 300_000,
		});

		await page.goto("/#/contacts");
		await expect(page.getByRole("button", { name: displayName })).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.getByText(`${displayName} is online`)).toBeVisible();
	});
});
