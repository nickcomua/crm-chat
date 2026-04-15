import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");
const CONVEX_DIR = path.join(ROOT, "bins/convex-backend");

export default function globalSetup(): void {
  // Environment variables are injected by `secretspec run --profile e2e_web`
  // via the package.json test scripts.

  // Install Convex dependencies up front so the first workspace that runs
  // `devenv up` doesn't race on `bun install` inside convex-backend.
  console.log("[e2e] Installing Convex dependencies...");
  const bunResult = spawnSync("bun", ["install"], {
    cwd: CONVEX_DIR,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (bunResult.error) {
    throw new Error(
      `bun install could not be started: ${bunResult.error.message}`
    );
  }
  if (bunResult.status !== 0) {
    throw new Error(
      `bun install failed:\n${bunResult.stdout}\n${bunResult.stderr}`
    );
  }

  console.log("[e2e] Global setup complete");
}
