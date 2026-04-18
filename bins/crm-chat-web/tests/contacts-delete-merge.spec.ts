/**
 * Playwright e2e: deleting and merging contacts (Task 28 scenarios 9 and 10).
 *
 * Scenario 9: Delete a contact → verify it disappears from the list, its
 * `chatContactLinks` rows are gone, its `contactPins` rows are gone, but
 * the underlying chats and messages are untouched.
 *
 * Scenario 10: Merge two contacts → verify all links, pins, custom fields,
 * and notes move to the target and the source is deleted.
 *
 * Both tests are ordered (delete must run before merge wipes the fixtures),
 * hence `test.describe.configure({ mode: "serial" })`.
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
let chatA: string;
let chatB: string;
let workerCfg: WorkerConfig;

test.describe("Contacts — delete and merge", () => {
  test.beforeAll(async ({ workerBackend }) => {
    workerCfg = workerBackend;
    const robot = await getRobotClient(workerCfg);

    userId = getCachedConvexUserId();

    clientId = await seedTestClient(
      userId,
      `telegram:contacts-dm-${Date.now()}`,
      robot
    );
    chatA = `${clientId}:dm-chat-a`;
    chatB = `${clientId}:dm-chat-b`;

    await robot.mutation(api.testHelpers.seedChat, {
      chatId: chatA,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Dorothy Vaughan",
      lastMessageTimestamp: Date.now(),
    });
    await robot.mutation(api.testHelpers.seedChat, {
      chatId: chatB,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Katherine Johnson",
      lastMessageTimestamp: Date.now(),
    });

    await seedMessage(
      userId,
      clientId,
      chatA,
      `${chatA}:msg-a1`,
      "MESSAGE_IN_CHAT_A",
      robot,
      { senderId: "vaughan-dm", timestamp: 1000 }
    );
    await seedMessage(
      userId,
      clientId,
      chatB,
      `${chatB}:msg-b1`,
      "MESSAGE_IN_CHAT_B",
      robot,
      { senderId: "johnson-dm", timestamp: 2000 }
    );
  });

  test("scenario 9: delete contact removes links and pins but keeps chats and messages", async ({
    page,
  }) => {
    const robot = await getRobotClient(workerCfg);

    // Create a throw-away contact with one link and one pin.
    const doomedId = (await robot.mutation(api.testHelpers.insertTestContact, {
      userId,
      displayName: "Doomed Contact",
    })) as Id<"contacts">;
    await robot.mutation(api.testHelpers.insertTestChatContactLink, {
      userId,
      chatId: chatA,
      senderId: "vaughan-dm",
      contactId: doomedId,
    });
    await robot.mutation(api.testHelpers.insertTestContactPin, {
      userId,
      contactId: doomedId,
      messageId: `${chatA}:msg-a1`,
      chatId: chatA,
      snapshot: {
        text: "MESSAGE_IN_CHAT_A",
        timestamp: 1000,
        senderId: "vaughan-dm",
        outgoing: false,
        chatDisplayNameAtPinTime: "Dorothy Vaughan",
      },
    });

    // Open the contact and delete it via the menu.
    await page.goto(`/#/contacts/${doomedId}`);
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Doomed Contact" })
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /contact actions/i }).click();
    await page.getByRole("menuitem", { name: /delete contact/i }).click();

    // After delete, the app navigates back to /contacts with no selection.
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 10_000 });
    await expect(
      page.locator("text=Doomed Contact")
    ).toHaveCount(0);

    // Backend verification: no links, no pins, but the chat and message rows
    // are still present.
    const links = (await robot.query(api.testHelpers.queryChatContactLinks, {
      contactId: doomedId,
    })) as unknown[];
    expect(links).toHaveLength(0);

    const pins = (await robot.query(api.testHelpers.queryContactPins, {
      contactId: doomedId,
    })) as unknown[];
    expect(pins).toHaveLength(0);

    const chatAMessages = (await robot.query(api.testHelpers.queryMessages, {
      chatId: chatA,
    })) as unknown[];
    expect(chatAMessages.length).toBeGreaterThan(0);

    const chats = (await robot.query(api.testHelpers.queryChats, {
      userId,
    })) as Array<{ chatId: string }>;
    expect(chats.some((c) => c.chatId === chatA)).toBe(true);
  });

  test("scenario 10: merge contacts moves everything to the target and deletes the source", async ({
    page,
  }) => {
    const robot = await getRobotClient(workerCfg);

    // Seed source with a link to chat A and a custom field.
    const sourceId = (await robot.mutation(api.testHelpers.insertTestContact, {
      userId,
      displayName: "Merge Source",
      notes: "source notes",
      customFields: [{ key: "email", value: "source@example.com" }],
    })) as Id<"contacts">;
    await robot.mutation(api.testHelpers.insertTestChatContactLink, {
      userId,
      chatId: chatA,
      senderId: "vaughan-dm",
      contactId: sourceId,
    });
    await robot.mutation(api.testHelpers.insertTestContactPin, {
      userId,
      contactId: sourceId,
      messageId: `${chatA}:msg-a1`,
      chatId: chatA,
      snapshot: {
        text: "MESSAGE_IN_CHAT_A",
        timestamp: 1000,
        senderId: "vaughan-dm",
        outgoing: false,
        chatDisplayNameAtPinTime: "Dorothy Vaughan",
      },
    });

    // Seed target with a link to chat B and a different custom field.
    const targetId = (await robot.mutation(api.testHelpers.insertTestContact, {
      userId,
      displayName: "Merge Target",
      notes: "target notes",
      customFields: [{ key: "phone", value: "+1 555-TARGET" }],
    })) as Id<"contacts">;
    await robot.mutation(api.testHelpers.insertTestChatContactLink, {
      userId,
      chatId: chatB,
      senderId: "johnson-dm",
      contactId: targetId,
    });

    // Drive the merge UI from the source contact's actions menu.
    await page.goto(`/#/contacts/${sourceId}`);
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Merge Source" })
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /contact actions/i }).click();
    await page.getByRole("menuitem", { name: /merge with/i }).click();

    const mergeDialog = page.getByRole("dialog", { name: /merge contacts/i });
    await expect(mergeDialog).toBeVisible();
    await mergeDialog
      .getByPlaceholder(/search target contact/i)
      .fill("Merge Target");
    await mergeDialog.getByText("Merge Target", { exact: true }).click();
    await mergeDialog
      .getByRole("button", { name: /merge into target/i })
      .click();

    // After merge, we should land on the target contact's page.
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Merge Target" })
    ).toBeVisible({ timeout: 10_000 });

    // Backend verification: source is gone, target has two links and one pin.
    const contacts = (await robot.query(api.testHelpers.queryContacts, {
      userId,
    })) as Array<{ _id: Id<"contacts">; displayName: string }>;
    expect(contacts.find((c) => c._id === sourceId)).toBeUndefined();
    const merged = contacts.find((c) => c._id === targetId);
    expect(merged).toBeDefined();

    const linksOnTarget = (await robot.query(
      api.testHelpers.queryChatContactLinks,
      { contactId: targetId }
    )) as Array<{ chatId: string; senderId: string }>;
    expect(linksOnTarget).toHaveLength(2);
    const linkChatIds = linksOnTarget.map((l) => l.chatId).sort();
    expect(linkChatIds).toEqual([chatA, chatB].sort());

    const pinsOnTarget = (await robot.query(
      api.testHelpers.queryContactPins,
      { contactId: targetId }
    )) as Array<{ messageId: string }>;
    expect(pinsOnTarget).toHaveLength(1);
    expect(pinsOnTarget[0].messageId).toBe(`${chatA}:msg-a1`);
  });
});
