import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("workspace-smoke-b: vite serves index", async ({ page, baseURL }) => {
  // Mirror of smoke-a. With --workers=2 these two files land on two
  // different workers, so each triggers its own workerBackend fixture →
  // its own `workspace-new` → its own isolated devenv up on offset ports.
  await page.goto(baseURL ?? "/");
  await expect(page.locator("#root")).toBeAttached();
  console.log(`[smoke-b] baseURL=${baseURL}`);
});
