/**
 * Playwright e2e: pinning messages to a contact and surviving a hard-delete
 * cascade triggered by disabling chat scanning (Task 28 scenarios 6 and 11).
 *
 * Scenario 6: Pin → verify pin appears in the panel, survives reload, and
 * shows a pin indicator on the bubble in both the single-chat tab and the
 * merged "All dialogs" view.
 *
 * Scenario 11: Pin a message, then call `chats.updateScanEnabled(false)` via
 * the robot client (simulating the "disable scanning" UI toggle). The
 * mutation purges every row in `messages` for that chat. Verify the pinned
 * snapshot still renders in the pinned panel as `isOrphaned: true` with the
 * "original no longer available" indicator.
 */

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
const CONTACTS_URL_PATTERN = /\/#\/contacts/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let chatId: string;
let contactId: Id<"contacts">;
let workerCfg: WorkerConfig;

test.describe("Contacts — pinned messages", () => {
  test.beforeAll(async ({ browser, workerBackend }) => {
    workerCfg = workerBackend;
    const robot = await getRobotClient(workerCfg);

    const context = await browser.newContext({
      storageState: "tests/.auth/user.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });
    userId = await getConvexUserId(page);
    await context.close();

    clientId = await seedTestClient(
      userId,
      `telegram:contacts-pins-${Date.now()}`,
      robot
    );
    chatId = `${clientId}:pins-chat`;

    await robot.mutation(api.testHelpers.seedChat, {
      chatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Nikola Tesla",
      lastMessageTimestamp: Date.now(),
    });

    // Seed three incoming messages. senderId "tesla-dm" becomes the sender
    // auto-detected by `resolveDefaultSenderId`.
    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:pin-msg-1`,
      "PIN_TARGET_MESSAGE_ONE",
      robot,
      { senderId: "tesla-dm", timestamp: 1000 }
    );
    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:pin-msg-2`,
      "PIN_TARGET_MESSAGE_TWO",
      robot,
      { senderId: "tesla-dm", timestamp: 2000 }
    );
    await seedMessage(
      userId,
      clientId,
      chatId,
      `${chatId}:pin-msg-3`,
      "OTHER_MESSAGE",
      robot,
      { senderId: "tesla-dm", timestamp: 3000 }
    );

    // Create the contact directly so we have a stable contactId.
    contactId = (await robot.mutation(api.testHelpers.insertTestContact, {
      userId,
      displayName: "Nikola Tesla",
    })) as Id<"contacts">;
    await robot.mutation(api.testHelpers.insertTestChatContactLink, {
      userId,
      chatId,
      senderId: "tesla-dm",
      contactId,
    });
  });

  test("scenario 6: pin → indicator in single chat, merged view, and survives reload", async ({
    page,
  }) => {
    // Open the underlying chat and pin the first message via the bubble
    // hover action.
    await page.goto(`/#/chats/${encodeURIComponent(chatId)}`);
    await page.waitForURL(/\/#\/chats\//, { timeout: 15_000 });
    await expect(
      page.locator("text=PIN_TARGET_MESSAGE_ONE").first()
    ).toBeVisible({ timeout: 15_000 });

    // Hover the target bubble so the pin button becomes visible, then click.
    const targetBubble = page.locator(
      '[data-message-id$=":pin-msg-1"]'
    );
    await targetBubble.hover();
    await targetBubble
      .getByRole("button", { name: /pin to contact/i })
      .click();

    // After pinning, the indicator on the bubble flips to "Pinned to contact".
    await expect(
      targetBubble.getByLabel(/pinned to contact/i)
    ).toBeVisible({ timeout: 5_000 });

    // Navigate to the contact page and verify the pin appears in the panel.
    await page.goto(`/#/contacts/${contactId}`);
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 10_000 });
    await page.getByRole("button", { name: /contact details/i }).click();

    const sheet = page.getByRole("dialog", { name: /contact details/i });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText("PIN_TARGET_MESSAGE_ONE").first()
    ).toBeVisible({ timeout: 10_000 });

    // Pin indicator in the merged "All dialogs" view. Dismiss the sheet so
    // we can see the timeline again.
    await page.keyboard.press("Escape");
    const mergedPinned = page.locator(
      '[data-message-id$=":pin-msg-1"] [aria-label="Pinned to contact"]'
    );
    await expect(mergedPinned.first()).toBeVisible({ timeout: 10_000 });

    // Reload the page and verify the pin survives.
    await page.reload();
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
    await page.getByRole("button", { name: /contact details/i }).click();
    const sheetAfter = page.getByRole("dialog", {
      name: /contact details/i,
    });
    await expect(
      sheetAfter.getByText("PIN_TARGET_MESSAGE_ONE").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("scenario 11: disabling scan purges messages, pin snapshot still renders as orphaned", async ({
    page,
  }) => {
    const robot = await getRobotClient(workerCfg);

    // Hard-delete all messages for the chat via `updateScanEnabled(false)`.
    // This is the same path the client-settings toggle exercises.
    const res = await robot.mutation(api.model.chats.updateScanEnabled, {
      chatId,
      scanEnabled: false,
    });
    expect(res).toMatchObject({ Ok: null });

    // Sanity check: there should be zero messages left for this chat.
    const remaining = (await robot.query(api.testHelpers.queryMessages, {
      chatId,
    })) as unknown[];
    expect(remaining).toHaveLength(0);

    // Open the contact and verify the pinned panel still shows the snapshot,
    // now marked with the "Original message no longer available" indicator.
    await page.goto(`/#/contacts/${contactId}`);
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
    await page.getByRole("button", { name: /contact details/i }).click();
    const sheet = page.getByRole("dialog", { name: /contact details/i });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText("PIN_TARGET_MESSAGE_ONE").first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      sheet.getByText(/original message no longer available/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
