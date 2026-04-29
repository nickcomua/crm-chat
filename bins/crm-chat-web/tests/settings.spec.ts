import { expect, test } from "./fixtures";
import {
	api,
	getConvexUserId,
	getRobotClient,
	type Id,
	seedTestClient,
	type WorkerConfig,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;
const SETTINGS_URL_PATTERN = /\/#\/settings/;
const CLIENT_URL_PATTERN = /\/#\/client\//;

test.describe.configure({ mode: "serial" });

let userId: string;
let workerCfg: WorkerConfig;

test.describe("Settings — Backend", () => {
	let connectedClientId: Id<"clients">;
	let errorClientId: Id<"clients">;

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

	test("registers a Connected client via robot API", async () => {
		const robot = await getRobotClient(workerCfg);
		connectedClientId = await seedTestClient(
			userId,
			`telegram:settings-connected-${Date.now()}`,
			robot,
		);
		expect(connectedClientId).toBeTruthy();

		// Query the client and verify status
		const client = (await robot.query(api.model.clients.getForWorker, {
			clientId: connectedClientId,
		})) as { status: { type: string } } | null;

		expect(client).toBeTruthy();
		expect(client?.status.type).toBe("Connected");
	});

	test("client list returns registered clients", async () => {
		const robot = await getRobotClient(workerCfg);
		// Register a second client
		errorClientId = (await robot.mutation(
			api.model.clients.workerRegisterConnected,
			{
				userId,
				telegramId: `telegram:settings-error-${Date.now()}`,
				kind: "Telegram",
			},
		)) as Id<"clients">;

		// Set it to Error status via a direct patch (robot can do this)
		// Since there's no direct "setError" mutation, we verify both exist
		const client1 = await robot.query(api.model.clients.getForWorker, {
			clientId: connectedClientId,
		});
		const client2 = await robot.query(api.model.clients.getForWorker, {
			clientId: errorClientId,
		});

		expect(client1).toBeTruthy();
		expect(client2).toBeTruthy();
	});

	test("deleteClient removes client from DB", async () => {
		const robot = await getRobotClient(workerCfg);
		// Create a throwaway client to delete
		const tempClientId = await seedTestClient(
			userId,
			`telegram:settings-delete-${Date.now()}`,
			robot,
		);

		// Verify it exists
		const before = await robot.query(api.model.clients.getForWorker, {
			clientId: tempClientId,
		});
		expect(before).toBeTruthy();

		// Delete it
		await robot.mutation(api.testHelpers.deleteClient, {
			clientId: tempClientId,
		});

		// Verify it's gone
		const after = await robot.query(api.model.clients.getForWorker, {
			clientId: tempClientId,
		});
		expect(after).toBeNull();
	});

	test("deleteClient also removes associated chats", async () => {
		const robot = await getRobotClient(workerCfg);
		// seedTestClient creates a client + 3 chats. Verify deletion cascades.
		const tempClientId = await seedTestClient(
			userId,
			`telegram:settings-cascade-${Date.now()}`,
			robot,
		);

		// Verify chats exist before deletion
		const chatsBefore = (await robot.query(api.testHelpers.queryChats, {
			userId,
		})) as Array<{
			chatId: string;
		}>;
		const ourChatsBefore = chatsBefore.filter((c) =>
			c.chatId.startsWith(tempClientId),
		);
		expect(ourChatsBefore.length).toBeGreaterThanOrEqual(1);

		await robot.mutation(api.testHelpers.deleteClient, {
			clientId: tempClientId,
		});

		// Client should be gone
		const client = await robot.query(api.model.clients.getForWorker, {
			clientId: tempClientId,
		});
		expect(client).toBeNull();

		// Chats belonging to deleted client should also be gone
		const chatsAfter = (await robot.query(api.testHelpers.queryChats, {
			userId,
		})) as Array<{
			chatId: string;
		}>;
		const ourChatsAfter = chatsAfter.filter((c) =>
			c.chatId.startsWith(tempClientId),
		);
		expect(ourChatsAfter.length).toBe(0);
	});
});

test.describe("Settings — UI", () => {
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
		await seedTestClient(userId, `telegram:settings-ui-${Date.now()}`, robot);

		await context.close();
	});

	test("settings page renders with 'Telegram Clients' header", async ({
		page,
	}) => {
		await page.goto("/#/settings");
		await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

		// Verified: telegram-clients-manager.tsx:100 — <h2>Telegram Clients</h2>
		await expect(page.locator("text=Telegram Clients")).toBeVisible({
			timeout: 10_000,
		});
		// Verified: telegram-clients-manager.tsx:103
		await expect(
			page.locator("text=Your connected Telegram accounts"),
		).toBeVisible();
	});

	test("shows connected client with status badge", async ({ page }) => {
		await page.goto("/#/settings");
		await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

		// At least one client card should be visible with "Connected" status
		await expect(page.locator("text=Connected").first()).toBeVisible({
			timeout: 10_000,
		});
	});

	test("'Add Client' button is visible", async ({ page }) => {
		await page.goto("/#/settings");
		await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

		// Verified: telegram-clients-manager.tsx:111 — <Button>Add Client</Button>
		const addButton = page.locator('button:has-text("Add Client")');
		await expect(addButton.first()).toBeVisible({ timeout: 10_000 });
	});

	test("'Add Client' opens QR dialog", async ({ page }) => {
		await page.goto("/#/settings");
		await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

		const addButton = page.locator('button:has-text("Add Client")').first();
		await addButton.click();

		// Verified: telegram-clients-manager.tsx:171 — <DialogTitle>Add Telegram Client</DialogTitle>
		// Verified: telegram-clients-manager.tsx:173 — "Scan this QR code..."
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog.locator("text=Add Telegram Client")).toBeVisible();
		await expect(dialog.locator("text=Scan this QR code")).toBeVisible();

		// Close dialog
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden({ timeout: 5000 });
	});

	test("client card shows delete button on hover", async ({ page }) => {
		await page.goto("/#/settings");
		await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

		// Verified: telegram-clients-manager.tsx:196 — <Card className="group ...">
		const clientCard = page.locator(".group").first();
		await expect(clientCard).toBeVisible({ timeout: 10_000 });
		await clientCard.hover();

		// Delete button (trash icon) should become visible
		// The button with Trash2 icon has no text, just an SVG
		const deleteButtons = clientCard.locator("button").filter({
			has: page.locator("svg"),
		});
		await expect(deleteButtons.last()).toBeVisible({ timeout: 5000 });
	});

	test("client card shows settings button for connected clients", async ({
		page,
	}) => {
		await page.goto("/#/settings");
		await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

		// Wait for at least one connected client card
		const connectedCard = page
			.locator(".group")
			.filter({ hasText: "Connected" })
			.first();
		await expect(connectedCard).toBeVisible({ timeout: 10_000 });

		await connectedCard.hover();

		// Verified: telegram-clients-manager.tsx:212 — aria-label="Client settings"
		const settingsBtn = connectedCard.locator(
			'button[aria-label="Client settings"]',
		);
		await expect(settingsBtn).toBeVisible({ timeout: 5000 });
	});

	test("settings button navigates to client detail page", async ({ page }) => {
		await page.goto("/#/settings");
		await page.waitForURL(SETTINGS_URL_PATTERN, { timeout: 10_000 });

		const connectedCard = page
			.locator(".group")
			.filter({ hasText: "Connected" })
			.first();
		await expect(connectedCard).toBeVisible({ timeout: 10_000 });

		await connectedCard.hover();

		const settingsBtn = connectedCard.locator(
			'button[aria-label="Client settings"]',
		);
		await expect(settingsBtn).toBeVisible({ timeout: 5000 });
		await settingsBtn.click();

		// Should navigate to /client/<id>
		await page.waitForURL(CLIENT_URL_PATTERN, { timeout: 10_000 });
	});
});
