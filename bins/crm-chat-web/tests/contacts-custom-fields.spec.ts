/**
 * Playwright e2e: custom fields persistence and searching contacts via the
 * search dialog by custom-field value (Task 28 scenarios 4 and 5).
 */

import { expect, test } from "./fixtures";
import {
  api,
  getCachedConvexUserId,
  getRobotClient,
  type Id,
  seedTestClient,
  type WorkerConfig,
} from "./helpers";

const CHATS_URL_PATTERN = /\/#\/chats/;
const CONTACTS_URL_PATTERN = /\/#\/contacts/;

test.describe.configure({ mode: "serial" });

let userId: string;
let clientId: Id<"clients">;
let contactId: Id<"contacts">;
let workerCfg: WorkerConfig;

test.describe("Contacts — custom fields", () => {
  test.beforeAll(async ({ workerBackend }) => {
    workerCfg = workerBackend;
    const robot = await getRobotClient(workerCfg);

    userId = getCachedConvexUserId();

    clientId = await seedTestClient(
      userId,
      `telegram:contacts-fields-${Date.now()}`,
      robot
    );

    // Seed a contact directly via testHelpers — we don't need the full
    // "create-from-dialog" flow for this scenario.
    contactId = (await robot.mutation(api.testHelpers.insertTestContact, {
      userId,
      displayName: "Marie Curie",
    })) as Id<"contacts">;
  });

  test("scenario 4: adding two custom fields persists after reload", async ({
    page,
  }) => {
    await page.goto(`/#/contacts/${contactId}`);
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });

    // The contact view renders — open the details sheet where the custom
    // fields editor lives.
    await expect(
      page.getByRole("heading", { name: "Marie Curie" })
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /contact details/i }).click();

    const sheet = page.getByRole("dialog", { name: /contact details/i });
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    // Add first field: email = marie@radium.org
    await sheet.getByRole("button", { name: /add custom field/i }).click();
    const keyInputs = sheet.getByLabel(/field key/i);
    const valueInputs = sheet.getByLabel(/field value/i);
    await keyInputs.first().fill("email");
    await valueInputs.first().fill("marie@radium.org");

    // Add second field: city = Paris
    await sheet.getByRole("button", { name: /add custom field/i }).click();
    await keyInputs.nth(1).fill("city");
    await valueInputs.nth(1).fill("Paris");

    await sheet.getByRole("button", { name: /save changes/i }).click();

    // After save, the dirty action bar disappears.
    await expect(
      sheet.getByRole("button", { name: /save changes/i })
    ).toBeHidden({ timeout: 5_000 });

    // Reload the page and reopen the sheet — values should still be there.
    await page.reload();
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Marie Curie" })
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /contact details/i }).click();

    const sheetAfter = page.getByRole("dialog", { name: /contact details/i });
    await expect(sheetAfter).toBeVisible({ timeout: 10_000 });
    await expect(sheetAfter.getByLabel(/field key/i).first()).toHaveValue(
      "email"
    );
    await expect(sheetAfter.getByLabel(/field value/i).first()).toHaveValue(
      "marie@radium.org"
    );
    await expect(sheetAfter.getByLabel(/field key/i).nth(1)).toHaveValue(
      "city"
    );
    await expect(sheetAfter.getByLabel(/field value/i).nth(1)).toHaveValue(
      "Paris"
    );
  });

  test("scenario 5: search dialog finds contact by custom-field value", async ({
    page,
  }) => {
    // Open any page inside the auth layout so the header search button is visible.
    await page.goto("/#/chats");
    await page.waitForURL(CHATS_URL_PATTERN, { timeout: 15_000 });

    // Click the search button in the top bar.
    await page
      .getByRole("button", { name: /search messages/i })
      .first()
      .click();

    const searchDialog = page.getByRole("dialog", { name: /search messages/i });
    await expect(searchDialog).toBeVisible({ timeout: 5_000 });

    // Type the custom-field VALUE — not the contact name. The backend's
    // searchByCustomFields uses the derived `customFieldsBlob` index.
    await searchDialog.getByPlaceholder(/search messages/i).fill("radium");

    // Marie should appear in the Contacts section of the results.
    await expect(
      searchDialog.getByText("Marie Curie", { exact: false }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Clicking the contact navigates to /contacts/<id>.
    await searchDialog.getByText("Marie Curie", { exact: false }).first().click();
    await page.waitForURL(CONTACTS_URL_PATTERN, { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Marie Curie" })
    ).toBeVisible({ timeout: 10_000 });
  });
});
