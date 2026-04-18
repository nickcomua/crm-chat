/**
 * Playwright e2e: creating a contact from a 1:1 dialog and attaching a second
 * one, then verifying the merged timeline (Task 28 scenarios 1 and 2 of
 * plans/2026-04-08-contacts-feature-v2.md).
 *
 * Environment assumptions:
 *   - The `workerBackend` fixture spins up a fresh Convex + crm-worker
 *     per worker process (see fixtures.ts). No external state needed.
 *   - Each test seeds two Dialog chats with a handful of incoming messages via
 *     the robot client and then drives the UI to create / attach a contact.
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
let chat1Id: string;
let chat2Id: string;
let workerCfg: WorkerConfig;

test.describe("Contacts — create from 1:1 dialog", () => {
  test.beforeAll(async ({ workerBackend }) => {
    workerCfg = workerBackend;
    const robot = await getRobotClient(workerCfg);

    userId = getCachedConvexUserId();

    clientId = await seedTestClient(
      userId,
      `telegram:contacts-create-${Date.now()}`,
      robot
    );
    chat1Id = `${clientId}:contacts-chat-a`;
    chat2Id = `${clientId}:contacts-chat-b`;

    // Seed two 1:1 Dialog chats with pinnedNames and interleaved messages.
    await robot.mutation(api.testHelpers.seedChat, {
      chatId: chat1Id,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Ada Lovelace",
      lastMessageTimestamp: Date.now(),
    });
    await robot.mutation(api.testHelpers.seedChat, {
      chatId: chat2Id,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Ada (Work)",
      lastMessageTimestamp: Date.now(),
    });

    // Chat A messages — timestamps 1000, 3000, 5000. senderId "ada-personal".
    await seedMessage(
      userId,
      clientId,
      chat1Id,
      `${chat1Id}:msg-a1`,
      "Hello from personal chat",
      robot,
      { senderId: "ada-personal", timestamp: 1000 }
    );
    await seedMessage(
      userId,
      clientId,
      chat1Id,
      `${chat1Id}:msg-a2`,
      "Second personal message",
      robot,
      { senderId: "ada-personal", timestamp: 3000 }
    );
    await seedMessage(
      userId,
      clientId,
      chat1Id,
      `${chat1Id}:msg-a3`,
      "Third personal message",
      robot,
      { senderId: "ada-personal", timestamp: 5000 }
    );

    // Chat B messages — timestamps 2000, 4000. senderId "ada-work".
    // When merged, the ordering (newest → oldest) is:
    //   a3 (5000, personal), b2 (4000, work), a2 (3000, personal),
    //   b1 (2000, work), a1 (1000, personal).
    await seedMessage(
      userId,
      clientId,
      chat2Id,
      `${chat2Id}:msg-b1`,
      "Hello from work chat",
      robot,
      { senderId: "ada-work", timestamp: 2000 }
    );
    await seedMessage(
      userId,
      clientId,
      chat2Id,
      `${chat2Id}:msg-b2`,
      "Second work message",
      robot,
      { senderId: "ada-work", timestamp: 4000 }
    );
  });

  test("scenario 1: create contact from a 1:1 dialog shows its messages", async ({
    page,
  }) => {
    // Open the first chat.
    await page.goto(`/#/chats/${encodeURIComponent(chat1Id)}`);
    await page.waitForURL(/\/#\/chats\//, { timeout: 15_000 });

    // Wait for the message list to render at least one bubble from the chat.
    await expect(
      page.locator("text=Hello from personal chat").first()
    ).toBeVisible({ timeout: 15_000 });

    // Open the contacts dropdown in the chat header.
    await page.getByRole("button", { name: /contact actions/i }).click();
    await page
      .getByRole("menuitem", { name: /create contact from this dialog/i })
      .click();

    // The create-contact dialog appears with Ada Lovelace pre-filled.
    const dialog = page.getByRole("dialog", {
      name: /create contact from dialog/i,
    });
    await expect(dialog).toBeVisible();
    const nameInput = dialog.getByLabel(/display name/i);
    await expect(nameInput).toHaveValue("Ada Lovelace");

    // Wait for the sender to auto-detect (defaultSender query resolves).
    await expect(dialog.getByText(/auto-detected/i)).toBeVisible({
      timeout: 10_000,
    });

    // Submit. The dialog closes and the URL becomes /contacts/<id>.
    await dialog.getByRole("button", { name: /^create contact$/i }).click();
    await page.waitForURL(/\/#\/contacts\//, { timeout: 15_000 });

    // The per-contact view should render the seeded chat's messages in the
    // default "All dialogs" (merged) tab. At this point the contact has
    // exactly one linked sender, so the merged timeline === chat A.
    await expect(
      page.locator("text=Third personal message").first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("text=Second personal message").first()
    ).toBeVisible();
    await expect(
      page.locator("text=Hello from personal chat").first()
    ).toBeVisible();

    // Work-chat messages should NOT be visible yet — we haven't attached
    // that chat to the contact.
    await expect(
      page.locator("text=Hello from work chat")
    ).toHaveCount(0);
  });

  test("scenario 2: attaching a second 1:1 dialog interleaves the merged timeline", async ({
    page,
  }) => {
    // Navigate to the contacts list and open the contact we created above.
    await page.goto("/#/contacts");
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
    await page.getByRole("button", { name: /Ada Lovelace/ }).first().click();
    await page.waitForURL(/\/#\/contacts\//, { timeout: 10_000 });

    // Switch to chat B and attach it to the existing contact.
    await page.goto(`/#/chats/${encodeURIComponent(chat2Id)}`);
    await page.waitForURL(/\/#\/chats\//, { timeout: 15_000 });
    await expect(
      page.locator("text=Hello from work chat").first()
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /contact actions/i }).click();
    await page
      .getByRole("menuitem", { name: /attach to existing contact/i })
      .click();

    const attachDialog = page.getByRole("dialog", {
      name: /attach dialog to contact/i,
    });
    await expect(attachDialog).toBeVisible();
    // Pick the Ada Lovelace contact from the command list.
    await attachDialog
      .getByPlaceholder(/search contacts/i)
      .fill("Ada Lovelace");
    await attachDialog.getByText("Ada Lovelace", { exact: true }).click();

    // Success screen → open the contact.
    await expect(
      attachDialog.getByText(/dialog linked successfully/i)
    ).toBeVisible({ timeout: 10_000 });
    await attachDialog.getByRole("button", { name: /open contact/i }).click();
    await page.waitForURL(/\/#\/contacts\//, { timeout: 10_000 });

    // The merged "All dialogs" tab should now show messages from BOTH chats,
    // and scenario 2 specifically tests that they're interleaved by timestamp:
    //   newest → oldest: a3, b2, a2, b1, a1.
    // We verify each message is visible, then assert DOM order.
    await expect(
      page.locator("text=Third personal message").first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("text=Second work message").first()
    ).toBeVisible();
    await expect(
      page.locator("text=Hello from work chat").first()
    ).toBeVisible();

    // The merged-timeline virtualizer renders bubbles in DOM order matching
    // the desc-by-timestamp order returned by listMergedMessages. Grab the
    // text of every visible bubble and verify the expected interleave.
    const bubbleTexts = await page
      .locator("[data-message-id] p.whitespace-pre-wrap")
      .allTextContents();

    // Filter to messages seeded by this test, preserving DOM order.
    // The merged timeline UI reverses the desc-by-timestamp query result so
    // that the oldest message sits at the top and newest at the bottom
    // (chat-style; see contact-merged-timeline.tsx:103). The interleave
    // below reflects that top-to-bottom DOM order.
    const expected = [
      "Hello from personal chat",
      "Hello from work chat",
      "Second personal message",
      "Second work message",
      "Third personal message",
    ];
    const filtered = bubbleTexts.filter((t) => expected.includes(t));
    expect(filtered).toEqual(expected);
  });
});
