import { expect, test } from "./fixtures";
import {
  api,
  getConvexUserId,
  getRobotClient,
  seedMessage,
  seedTestClient,
  type WorkerConfig,
} from "./helpers";

/**
 * Temporary debug test to investigate why seeded data doesn't render.
 * DELETE THIS FILE after investigation.
 */
let workerCfg: WorkerConfig;

test("debug: investigate seeded data visibility", async ({
  browser,
  workerBackend,
}) => {
  workerCfg = workerBackend;
  const context = await browser.newContext({
    storageState: "tests/.auth/user.json",
  });
  const page = await context.newPage();

  // 1. Navigate and get userId
  await page.goto("/");
  await page.waitForURL(/\/#\/chats/, { timeout: 15_000 });
  const userId = await getConvexUserId(page);
  console.log("[DEBUG] userId from getConvexUserId:", userId);

  // 2. Seed a test client + chats via robot
  const robot = getRobotClient(workerCfg);
  const clientId = await seedTestClient(
    userId,
    `telegram:debug-${Date.now()}`,
    robot
  );
  console.log("[DEBUG] seedTestClient returned clientId:", clientId);

  // 3. Seed a message
  const aliceChatId = `${clientId}:chat-pinned-1`;
  await seedMessage(
    userId,
    clientId,
    aliceChatId,
    `${aliceChatId}:msg-1`,
    "Debug message",
    {
      timestamp: Date.now(),
    },
    robot
  );

  // 4. Query backend to confirm data exists
  const chats = await robot.query(api.testHelpers.queryChats, { userId });
  console.log(
    "[DEBUG] Robot queryChats result:",
    JSON.stringify(chats, null, 2)
  );

  // 5. Check what browser sees — evaluate Convex state
  const browserInfo = await page.evaluate(() => {
    const w = globalThis as any;
    return {
      clerkUserId: w.Clerk?.user?.id ?? "NOT_FOUND",
      currentUrl: window.location.href,
      documentTitle: document.title,
    };
  });
  console.log("[DEBUG] Browser info:", JSON.stringify(browserInfo, null, 2));

  // 6. Wait a bit for reactive updates, then check page content
  await page.waitForTimeout(3000);

  // 7. Screenshot
  await page.screenshot({ path: "/tmp/debug-render.png", fullPage: true });
  console.log("[DEBUG] Screenshot saved to /tmp/debug-render.png");

  // 8. Dump page text content
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log(
    "[DEBUG] Page body text (first 2000 chars):",
    bodyText.slice(0, 2000)
  );

  // 9. Check for any console errors
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });

  // 10. Reload and wait again
  await page.reload();
  await page.waitForURL(/\/#\/chats/, { timeout: 10_000 });
  await page.waitForTimeout(3000);

  const bodyTextAfterReload = await page.evaluate(
    () => document.body.innerText
  );
  console.log(
    "[DEBUG] Page body after reload (first 2000 chars):",
    bodyTextAfterReload.slice(0, 2000)
  );
  await page.screenshot({
    path: "/tmp/debug-render-after-reload.png",
    fullPage: true,
  });

  // 11. Check if Alice appears
  const aliceVisible = await page.locator("text=Alice").count();
  const debugMsgVisible = await page.locator("text=Debug message").count();
  console.log("[DEBUG] Alice locators found:", aliceVisible);
  console.log("[DEBUG] 'Debug message' locators found:", debugMsgVisible);

  // 12. Check network — look at WebSocket connections
  const perfEntries = await page.evaluate(() => {
    return performance
      .getEntriesByType("resource")
      .filter(
        (r: any) =>
          r.name.includes("convex") ||
          r.name.includes("ws") ||
          r.name.includes("3210") ||
          r.name.includes(":")
      )
      .slice(0, 20)
      .map((r: any) => ({ name: r.name, type: r.initiatorType }));
  });
  console.log("[DEBUG] Network entries:", JSON.stringify(perfEntries, null, 2));

  // Cleanup
  await robot.mutation(api.testHelpers.deleteClient, { clientId });
  await page.close();

  // Force fail so we see all output
  expect(aliceVisible, "Alice should be visible after seeding").toBeGreaterThan(
    0
  );
});
