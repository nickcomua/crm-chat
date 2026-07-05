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

test.describe("Contacts presence", () => {
	test.beforeAll(async ({ workerBackend }) => {
		workerCfg = workerBackend;
	});

	test("shows online indicator and online timeline for a linked Telegram sender", async ({
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
		const contactId: Id<"contacts"> = await robot.mutation(
			api.testHelpers.insertTestContact,
			{
				userId,
				displayName,
			},
		);
		await robot.mutation(api.testHelpers.insertTestChatContactLink, {
			userId,
			chatId: "presence-chat",
			senderId: "presence-sender",
			contactId,
		});

		const observedAt = Date.now() - 10 * 60_000;
		await robot.mutation(api.model.contactPresence.workerRecordStatus, {
			userId,
			clientId,
			senderId: "presence-sender",
			status: "online",
			observedAt,
			expiresAt: Date.now() + 5 * 60_000,
			wasOnlineAt: observedAt,
		});

		await page.goto("/#/contacts");
		const contactRow = page.getByRole("button", { name: displayName });
		await expect(contactRow).toBeVisible({ timeout: 10_000 });
		await expect(
			contactRow.getByTestId("contact-online-indicator"),
		).toBeVisible();

		await contactRow.click();
		await page.getByRole("button", { name: "Contact details" }).click();
		await expect(
			page.getByRole("heading", { name: "Online timeline" }),
		).toBeVisible();
		await expect(page.getByTestId("contact-online-timeline")).toBeVisible();
		await expect(
			page.getByText(/Online from .* via presence-sender/),
		).toBeVisible();
	});
});
