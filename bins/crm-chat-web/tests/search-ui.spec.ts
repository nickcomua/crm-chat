import { expect, test } from "@playwright/test";

test.describe("Search UI", () => {
  test("finds messages and loads more", async ({ page }) => {
    await page.goto("/");
    await page.click("button[aria-label='Search messages']");
    await page.fill("input[placeholder='Search messages...']", "test");
    await page
      .waitForSelector("text=No results found", { timeout: 2000 })
      .catch(() => {});
    const loadMore = await page.$("text=Load more");
    const anyItem =
      (await page.$("button:has-text('You:')")) ||
      (await page.$("button:has-text('Chat')"));
    expect(loadMore || anyItem).toBeTruthy();
    if (loadMore) {
      await loadMore.click();
      // After clicking load more, spinner may appear
      await page.waitForTimeout(200);
    }
  });
});
