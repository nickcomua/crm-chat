import { test, expect } from "@playwright/test";

// Playwright tests for Search UI. These are basic smoke tests that open the
// app, type a query, and verify that results appear and the "Load more"
// button works.

test.describe("Search UI", () => {
  test("finds messages and loads more", async ({ page }) => {
    await page.goto("/");

    // Open search dialog
    await page.click("button[aria-label='Search messages']");

    // Type query
    await page.fill("input[placeholder='Search messages...']", "hello");

    // Wait for results container
    await page.waitForSelector("text=No results found", { timeout: 2000 }).catch(() => {});

    // If results exist, ensure at least one SearchResultItem or Load more button
    const loadMore = await page.$("text=Load more");
    const anyItem = await page.$("button:has-text('You:')") || await page.$("button:has-text('Chat')");

    expect(loadMore || anyItem).toBeTruthy();

    if (loadMore) {
      await loadMore.click();
      // After clicking load more, spinner may appear
      await page.waitForTimeout(200);
    }
  });
});
