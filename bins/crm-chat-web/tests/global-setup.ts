import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");
const CONVEX_DIR = path.join(ROOT, "bins/convex-backend");
const WORKER_BIN = path.join(ROOT, "target/debug/crm-worker");

export default function globalSetup(): void {
  // Environment variables are injected by `secretspec run --profile e2e_web`
  // via the package.json test scripts. Secretspec validates required vars
  // before the process starts, so no manual validation is needed here.

  // Install Convex dependencies (needed for bun x convex deploy in workers)
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

  // Build crm-worker binary (expensive — do once)
  console.log("[e2e] Building crm-worker...");
  const buildResult = spawnSync(
    "cargo",
    ["build", "-p", "crm-worker", "--quiet"],
    {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
      env: {
        ...process.env,
        // Prefer CommandLineTools to avoid Xcode license prompts blocking CI
        DEVELOPER_DIR:
          process.env.DEVELOPER_DIR ?? "/Library/Developer/CommandLineTools",
      },
    }
  );
  if (buildResult.error) {
    throw new Error(
      `cargo build could not be started: ${buildResult.error.message}`
    );
  }
  if (buildResult.status !== 0) {
    throw new Error(
      `cargo build failed:\n${buildResult.stdout}\n${buildResult.stderr}`
    );
  }

  // Expose binary path for worker fixtures
  process.env.E2E_WORKER_BIN = WORKER_BIN;
  console.log("[e2e] Global setup complete (binary built, deps installed)");
}
