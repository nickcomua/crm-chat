import { expect, test } from "./fixtures";
import {
	api,
	getCachedConvexUserId,
	getRobotClient,
	type Id,
	seedTestClient,
	type WorkerConfig,
} from "./helpers";

const CONTACTS_URL_PATTERN = /\/#\/contacts/;

test.describe.configure({ mode: "serial" });

let contactId: Id<"contacts">;
let workerCfg: WorkerConfig;

test.describe("Contacts — facts", () => {
	test.beforeAll(async ({ workerBackend }) => {
		workerCfg = workerBackend;
		const robot = await getRobotClient(workerCfg);
		const userId = getCachedConvexUserId();

		await seedTestClient(
			userId,
			`telegram:contacts-facts-${Date.now()}`,
			robot,
		);
		contactId = (await robot.mutation(api.testHelpers.insertTestContact, {
			userId,
			displayName: "Marie Curie",
		})) as Id<"contacts">;
	});

	test("adds a pinned high-priority fact and shows it across views", async ({
		page,
	}) => {
		await page.goto(`/#/contacts/${contactId}`);
		await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
		await expect(
			page.getByRole("heading", { name: "Marie Curie" }),
		).toBeVisible({ timeout: 10_000 });

		await page.getByRole("button", { name: /contact details/i }).click();
		const sheet = page.getByRole("dialog", { name: /contact details/i });
		await expect(sheet).toBeVisible({ timeout: 10_000 });

		await sheet.getByLabel("New fact").fill("Radium supplier");
		await sheet
			.getByPlaceholder("Optional details")
			.fill("Prefers evening calls");
		await sheet.getByRole("button", { name: "knowledge" }).click();
		await sheet.getByRole("button", { name: "high" }).click();
		await sheet.getByRole("button", { name: "Pin" }).click();
		await sheet.getByRole("button", { name: "Add" }).click();

		await expect(sheet.getByText("Radium supplier").first()).toBeVisible({
			timeout: 10_000,
		});
		await expect(
			sheet.getByText("Prefers evening calls").first(),
		).toBeVisible();

		await sheet.getByRole("tab", { name: /list/i }).click();
		await expect(sheet.getByText("Radium supplier").first()).toBeVisible();

		await sheet.getByRole("tab", { name: /priority/i }).click();
		await expect(sheet.getByText("high").first()).toBeVisible();

		await sheet.getByRole("tab", { name: /calendar/i }).click();
		await expect(sheet.getByText("Radium supplier").first()).toBeVisible();

		await page.reload();
		await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
		await page.getByRole("button", { name: /contact details/i }).click();
		const reloadedSheet = page.getByRole("dialog", {
			name: /contact details/i,
		});
		await expect(
			reloadedSheet.getByText("Radium supplier").first(),
		).toBeVisible({ timeout: 10_000 });
	});
});
