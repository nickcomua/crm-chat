import type { ChildProcess } from "node:child_process";
import type { StartedTestContainer } from "testcontainers";

declare global {
  var __E2E: {
    container: StartedTestContainer;
    restateContainer: StartedTestContainer;
    worker?: ChildProcess;
  };
}

export default async function globalTeardown(): Promise<void> {
  const e2e = globalThis.__E2E;
  if (!e2e) {
    return;
  }

  // Kill crm-worker
  if (e2e.worker && e2e.worker.exitCode === null) {
    console.log("[e2e] Stopping crm-worker...");
    e2e.worker.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        e2e.worker?.kill("SIGKILL");
        resolve();
      }, 5000);
      e2e.worker?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // Stop Restate container
  console.log("[e2e] Stopping Restate container...");
  await e2e.restateContainer.stop();

  // Stop Convex container
  console.log("[e2e] Stopping Convex container...");
  await e2e.container.stop();

  console.log("[e2e] Cleanup complete");
}
