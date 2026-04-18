/**
 * Playwright e2e: attaching a Group chat to a contact (Task 28 scenario 3).
 *
 * A group chat should appear as its own per-dialog tab on the contact page,
 * but `listMergedMessages` deliberately excludes Group chats from the "All
 * dialogs" merged timeline — that's the key assertion here.
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


test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let dialogChatId: string;
let groupChatId: string;
let workerCfg: WorkerConfig;

test.describe("Contacts — group chat filter", () => {
  test.beforeAll(async ({ workerBackend }) => {
    workerCfg = workerBackend;
    const robot = await getRobotClient(workerCfg);

    userId = getCachedConvexUserId();

    clientId = await seedTestClient(
      userId,
      `telegram:contacts-group-${Date.now()}`,
      robot
    );
    dialogChatId = `${clientId}:group-test-dm`;
    groupChatId = `${clientId}:group-test-grp`;

    await robot.mutation(api.testHelpers.seedChat, {
      chatId: dialogChatId,
      userId,
      clientId,
      chatType: "Dialog",
      isPinned: true,
      pinnedName: "Grace Hopper",
      lastMessageTimestamp: Date.now(),
    });
    await robot.mutation(api.testHelpers.seedChat, {
      chatId: groupChatId,
      userId,
      clientId,
      chatType: "Group",
      isPinned: true,
      pinnedName: "COBOL Team",
      lastMessageTimestamp: Date.now(),
    });

    // One message in each chat so the merged-timeline filter has something
    // observable to exclude.
    await seedMessage(
      userId,
      clientId,
      dialogChatId,
      `${dialogChatId}:msg-dm-1`,
      "MERGED_DIALOG_MESSAGE",
      robot,
      { senderId: "grace-dm", timestamp: 1000 }
    );
    await seedMessage(
      userId,
      clientId,
      groupChatId,
      `${groupChatId}:msg-grp-1`,
      "GROUP_ONLY_MESSAGE",
      robot,
      { senderId: "grace-grp", timestamp: 5000 }
    );
  });

  test("scenario 3: group chat tab appears but merged timeline excludes it", async ({
    page,
  }) => {
    // Create the contact from the DM first so we have a stable contact page.
    await page.goto(`/#/chats/${encodeURIComponent(dialogChatId)}`);
    await page.waitForURL(/\/#\/chats\//, { timeout: 15_000 });
    await expect(page.locator("text=MERGED_DIALOG_MESSAGE").first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: /contact actions/i }).click();
    await page
      .getByRole("menuitem", { name: /create contact from this dialog/i })
      .click();

    const createDialog = page.getByRole("dialog", {
      name: /create contact from dialog/i,
    });
    await expect(createDialog).toBeVisible();
    await expect(createDialog.getByText(/auto-detected/i)).toBeVisible({
      timeout: 10_000,
    });
    await createDialog
      .getByRole("button", { name: /^create contact$/i })
      .click();
    await page.waitForURL(/\/#\/contacts\//, { timeout: 15_000 });

    // Now attach the group chat to the same contact.
    await page.goto(`/#/chats/${encodeURIComponent(groupChatId)}`);
    await page.waitForURL(/\/#\/chats\//, { timeout: 15_000 });
    await expect(page.locator("text=GROUP_ONLY_MESSAGE").first()).toBeVisible({
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
    await attachDialog
      .getByPlaceholder(/search contacts/i)
      .fill("Grace Hopper");
    await attachDialog.getByText("Grace Hopper", { exact: true }).click();

    // Because this is a Group chat, the UI prompts for a sender to link.
    await expect(attachDialog.getByText(/pick the sender/i)).toBeVisible({
      timeout: 10_000,
    });
    await attachDialog.getByRole("option").first().click();

    await expect(
      attachDialog.getByText(/dialog linked successfully/i)
    ).toBeVisible({ timeout: 10_000 });
    await attachDialog.getByRole("button", { name: /open contact/i }).click();
    await page.waitForURL(/\/#\/contacts\//, { timeout: 10_000 });

    // The per-dialog tab list should now include both a tab for the DM and a
    // tab for the group chat. The group tab is marked with a "group" badge.
    const tablist = page.getByRole("tablist");
    await expect(tablist.getByRole("tab", { name: /all dialogs/i })).toBeVisible();
    await expect(tablist.getByRole("tab", { name: /Grace Hopper/ })).toBeVisible();
    await expect(
      tablist.getByRole("tab", { name: /COBOL Team.*group/i })
    ).toBeVisible();

    // "All dialogs" is selected by default. Verify it ONLY shows the DM's
    // message — the group's message must be filtered out.
    await expect(
      page.locator("text=MERGED_DIALOG_MESSAGE").first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=GROUP_ONLY_MESSAGE")).toHaveCount(0);

    // Clicking the group-chat tab should show the group's message directly.
    await tablist.getByRole("tab", { name: /COBOL Team.*group/i }).click();
    await expect(page.locator("text=GROUP_ONLY_MESSAGE").first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
