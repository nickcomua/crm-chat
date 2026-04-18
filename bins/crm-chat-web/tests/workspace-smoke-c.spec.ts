import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("workspace-smoke-c: vite serves index", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "/");
  await expect(page.locator("#root")).toBeAttached();
  console.log(`[smoke-c] baseURL=${baseURL}`);
});
