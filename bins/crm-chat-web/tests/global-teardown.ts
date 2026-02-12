import type { ChildProcess } from "node:child_process";
import type { StartedTestContainer } from "testcontainers";

declare global {
  var __E2E: {
    container: StartedTestContainer;
    subscriber?: ChildProcess;
  };
}

export default async function globalTeardown(): Promise<void> {
  const e2e = globalThis.__E2E;
  if (!e2e) {
    return;
  }

  // Kill telegram-subscriber
  if (e2e.subscriber && e2e.subscriber.exitCode === null) {
    console.log("[e2e] Stopping telegram-subscriber...");
    e2e.subscriber.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        e2e.subscriber?.kill("SIGKILL");
        resolve();
      }, 5000);
      e2e.subscriber?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // Stop Convex container
  console.log("[e2e] Stopping Convex container...");
  await e2e.container.stop();

  console.log("[e2e] Cleanup complete");
}
