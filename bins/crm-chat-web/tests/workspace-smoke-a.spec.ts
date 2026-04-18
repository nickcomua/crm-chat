import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("workspace-smoke-a: vite serves index", async ({ page, baseURL }) => {
  // Directly hit the workspace's vite server. No Clerk login / storage state
  // required — we're only validating that this worker got its own workspace
  // with its own isolated devenv up.
  await page.goto(baseURL ?? "/");
  await expect(page.locator("#root")).toBeAttached();
  // Log which backend this worker bound so a parallel run with workers=2
  // shows two distinct ports in the output.
  console.log(`[smoke-a] baseURL=${baseURL}`);
});
