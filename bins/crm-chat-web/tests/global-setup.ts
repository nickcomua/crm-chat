import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");
const CONVEX_DIR = path.join(ROOT, "bins/convex-backend");
const WORKER_BIN = path.join(ROOT, "target/debug/crm-worker");

/** Load .env from repo root (only sets vars not already in process.env). */
function loadEnvFile(): void {
  const envFile = path.join(ROOT, ".env");
  if (!existsSync(envFile)) {
    return;
  }
  const contents = readFileSync(envFile, "utf-8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1).replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export default async function globalSetup(): Promise<void> {
  loadEnvFile();

  // Validate required env vars
  for (const v of [
    "TEST_CLERK_USERNAME",
    "TEST_CLERK_PASSWORD",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "TG_ID",
    "TG_HASH",
  ]) {
    if (!process.env[v]) {
      throw new Error(`[e2e] Required env var ${v} is not set`);
    }
  }

  // Install Convex dependencies (needed for bunx convex deploy in workers)
  console.log("[e2e] Installing Convex dependencies...");
  const bunResult = spawnSync("bun", ["install"], {
    cwd: CONVEX_DIR,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (bunResult.status !== 0) {
    throw new Error(`bun install failed:\n${bunResult.stderr}`);
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
  if (buildResult.status !== 0) {
    throw new Error(`cargo build failed:\n${buildResult.stderr}`);
  }

  // Expose binary path for worker fixtures
  process.env.E2E_WORKER_BIN = WORKER_BIN;
  console.log("[e2e] Global setup complete (binary built, deps installed)");
}
