/**
 * Playwright e2e: unlinking a sender and re-linking (reassigning) a sender
 * that is already owned by another contact (Task 28 scenarios 7 and 8).
 *
 * Scenario 7: Unlink a sender from a contact → verify the contact page
 * updates and the merged timeline no longer shows that chat's messages.
 *
 * Scenario 8: Contact A already owns (chat, sender). Attempt to link the
 * same (chat, sender) to contact B from the Attach-to-Existing-Contact flow
 * → UI surfaces the reassign-conflict prompt → accept → verify A has zero
 * links for that pair and B now owns it.
 */

import { expect, test } from "./fixtures";
import {
	api,
	getCachedConvexUserId,
	getRobotClient,
	type Id,
	seedMessage,
	seedTestClient,
	type WorkerConfig,
} from "./helpers";

const CONTACTS_URL_PATTERN = /\/#\/contacts/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let chatId: string;
let contactAId: Id<"contacts">;
let contactBId: Id<"contacts">;
let workerCfg: WorkerConfig;

test.describe("Contacts — unlink and reassign", () => {
	test.beforeAll(async ({ workerBackend }) => {
		workerCfg = workerBackend;
		const robot = await getRobotClient(workerCfg);

		userId = getCachedConvexUserId();

		clientId = await seedTestClient(
			userId,
			`telegram:contacts-relink-${Date.now()}`,
			robot,
		);
		chatId = `${clientId}:relink-chat`;

		await robot.mutation(api.testHelpers.seedChat, {
			chatId,
			userId,
			clientId,
			chatType: "Dialog",
			isPinned: true,
			pinnedName: "Alan Turing",
			lastMessageTimestamp: Date.now(),
		});
		await seedMessage(
			userId,
			clientId,
			chatId,
			`${chatId}:msg-relink-1`,
			"RELINK_TEST_MESSAGE",
			robot,
			{ senderId: "turing-dm", timestamp: 1000 },
		);

		// Seed two contacts: A (initially owns the sender) and B (empty).
		contactAId = (await robot.mutation(api.testHelpers.insertTestContact, {
			userId,
			displayName: "Contact A",
		})) as Id<"contacts">;
		contactBId = (await robot.mutation(api.testHelpers.insertTestContact, {
			userId,
			displayName: "Contact B",
		})) as Id<"contacts">;

		// A currently owns (chatId, "turing-dm").
		await robot.mutation(api.testHelpers.insertTestChatContactLink, {
			userId,
			chatId,
			senderId: "turing-dm",
			contactId: contactAId,
		});
	});

	test("scenario 7: unlink a sender removes its messages from the merged timeline", async ({
		page,
	}) => {
		// Confirm A initially shows the message in the merged view.
		await page.goto(`/#/contacts/${contactAId}`);
		await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
		await expect(page.locator("text=RELINK_TEST_MESSAGE").first()).toBeVisible({
			timeout: 15_000,
		});

		// Open the actions menu → Unlink a sender → pick the only linked sender.
		await page.getByRole("button", { name: /contact actions/i }).click();
		await page.getByRole("menuitem", { name: /unlink a sender/i }).hover();
		// The submenu should reveal "Alan Turing · turing-dm…" — click it.
		await page.getByRole("menuitem", { name: /Alan Turing/i }).click();

		// After unlinking, the merged timeline should no longer show the
		// message — the empty-state placeholder takes over.
		await expect(
			page.getByText(/no messages to show for this contact yet/i),
		).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("text=RELINK_TEST_MESSAGE")).toHaveCount(0);

		// Re-seed the A-link so scenario 8 starts from a known state with A
		// owning (chatId, turing-dm) again.
		const robot = await getRobotClient(workerCfg);
		await robot.mutation(api.testHelpers.insertTestChatContactLink, {
			userId,
			chatId,
			senderId: "turing-dm",
			contactId: contactAId,
		});
	});

	test("scenario 8: reassign flow moves the sender from A to B on confirm", async ({
		page,
	}) => {
		// From the chat header, attach to contact B — this should conflict
		// because A already owns the sender.
		await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);
		await page.waitForURL(/\/#\/chats\//, { timeout: 15_000 });
		await expect(page.locator("text=RELINK_TEST_MESSAGE").first()).toBeVisible({
			timeout: 15_000,
		});

		await page.getByRole("button", { name: /contact actions/i }).click();
		await page
			.getByRole("menuitem", { name: /attach to existing contact/i })
			.click();

		const attachDialog = page.getByRole("dialog", {
			name: /attach dialog to contact/i,
		});
		await expect(attachDialog).toBeVisible();
		await attachDialog.getByPlaceholder(/search contacts/i).fill("Contact B");
		await attachDialog.getByText("Contact B", { exact: true }).click();

		// The conflict prompt should appear.
		await expect(
			attachDialog.getByText(/already linked to another contact/i),
		).toBeVisible({ timeout: 10_000 });

		// Confirm the reassign.
		await attachDialog.getByRole("button", { name: /^reassign$/i }).click();

		await expect(
			attachDialog.getByText(/dialog linked successfully/i),
		).toBeVisible({ timeout: 10_000 });
		// The dialog has two buttons with accessible name "Close": the explicit
		// footer `<button>Close</button>` and Radix's built-in `<button
		// data-slot="dialog-close">` "X" at the top-right corner. Target the
		// explicit footer button (the first match in document order).
		await attachDialog.getByRole("button", { name: "Close" }).first().click();

		// Verify A no longer owns the sender (empty merged timeline)
		await page.goto(`/#/contacts/${contactAId}`);
		await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 10_000 });
		await expect(
			page.getByText(/no messages to show for this contact yet/i),
		).toBeVisible({ timeout: 10_000 });

		// And B now shows the message.
		await page.goto(`/#/contacts/${contactBId}`);
		await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 10_000 });
		await expect(page.locator("text=RELINK_TEST_MESSAGE").first()).toBeVisible({
			timeout: 10_000,
		});
	});
});
