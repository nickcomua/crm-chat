/* eslint-disable no-empty-pattern */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { $ } from "zx";

$.shell = "/bin/sh";
$.prefix = "";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");

// ---------------------------------------------------------------------------
// Shared mutex — serializes the "enter shell + start devenv up + wait for
// backend to bind" phase across parallel Playwright workers so two workspaces
// never probe the same unbound port at the same time. Once the backend on
// port X is listening, subsequent probes correctly skip X.
// ---------------------------------------------------------------------------
let bootQueue: Promise<void> = Promise.resolve();
function serializeBoot<T>(fn: () => Promise<T>): Promise<T> {
  const next = bootQueue.then(fn, fn);
  bootQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// ---------------------------------------------------------------------------
// Parse `KEY=value` dotenv lines, stripping surrounding quotes.
// ---------------------------------------------------------------------------
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Poll a URL until it responds with 2xx or the deadline passes.
// ---------------------------------------------------------------------------
async function pollUntilReady(
  url: string,
  label: string,
  timeoutMs: number,
  intervalMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} not ready after ${timeoutMs}ms (url=${url})`);
}

// ---------------------------------------------------------------------------
// Poll for a file to appear.
// ---------------------------------------------------------------------------
async function pollUntilFile(
  filePath: string,
  label: string,
  timeoutMs: number,
  intervalMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} (${filePath}) not present after ${timeoutMs}ms`);
}

function onExit(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
    } else {
      proc.on("exit", (code) => resolve(code));
    }
  });
}

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------
interface TestFixtures {
  baseURL: string;
}

interface WorkerFixtures {
  workerBackend: {
    convexUrl: string;
    m2mSecretKey: string;
    sessionDir: string;
    baseURL: string;
  };
}

// ---------------------------------------------------------------------------
// Worker-scoped fixture — one independent devenv-up per Playwright worker.
//
// Per-worker isolation is provided by a fresh jj workspace at
// /tmp/crm-e2e-<wid>-<ts>:
//   * unique CWD → unique $DEVENV_ROOT → unique $DEVENV_STATE
//                → unique process-compose socket (/tmp/devenv-<hash>/pc.sock)
//   * workspace basename → unique COMPOSE_PROJECT_NAME → namespaced
//     container names + volumes
//   * Nix flake's enterShell probes free ports in `ss` and writes them to
//     <workspace>/.env + <workspace>/.devenv/state/admin_key, so the whole
//     stack self-discovers per-workspace without externally pre-allocating.
//
// The "enter shell + devenv up + wait for backend bind" phase is serialized
// via the module-level `bootQueue` mutex so two workspaces never try to grab
// the same unbound port at the same time. Tests themselves still run fully
// in parallel.
// ---------------------------------------------------------------------------
export const test = base.extend<TestFixtures, WorkerFixtures>({
  baseURL: async ({ workerBackend }, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(workerBackend.baseURL);
  },
  workerBackend: [
    // biome-ignore lint/correctness/noEmptyPattern: playwright fixture pattern
    async ({}, use) => {
      const wid = `${process.pid}-${Date.now()}`;
      const workspacePath = path.join(os.tmpdir(), `crm-e2e-${wid}`);
      const workspaceName = path.basename(workspacePath);

      let resources: {
        workspacePath: string;
        workspaceName: string;
        devenv?: ChildProcess;
      } = { workspacePath, workspaceName };

      try {
        // ── 1. Create a jj workspace ──────────────────────────────────
        console.log(`[${wid}] Creating jj workspace at ${workspacePath}...`);
        await $`jj -R ${ROOT} workspace add --name ${workspaceName} ${workspacePath}`;

        // ── 2. Seed the workspace .env from the main repo ────────────
        // The main .env carries every secret the devenv processes need
        // (Clerk, Telegram, etc.). enterShell will overwrite the port-
        // related keys once the devenv shell is entered. The previous
        // CONVEX_SELF_HOSTED_ADMIN_KEY is invalid against the new backend,
        // so the backend process's admin-key logic will regenerate it.
        const mainEnvPath = path.join(ROOT, ".env");
        const wsEnvPath = path.join(workspacePath, ".env");
        await fs.copyFile(mainEnvPath, wsEnvPath);
        // Append test-only overrides so devenv processes pick them up.
        const sessionDir = path.join(workspacePath, "target/crm-worker-data");
        await fs.mkdir(sessionDir, { recursive: true });
        await fs.appendFile(
          wsEnvPath,
          `\nTG_SESSION_DIR=${sessionDir}\nSCAN_REFRESH_SECS=5\n`
        );

        // ── 3-5. Serialized boot: enter devenv shell, start devenv up,
        //         wait for backend to bind. ────────────────────────────
        const { webPort, convexUrl, devenv } = await serializeBoot(async () => {
          // Strip inherited port vars so the workspace's enterShell actually
          // probes instead of reusing the parent's PORT.
          const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
          for (const k of [
            "PORT",
            "SITE_PROXY_PORT",
            "DASHBOARD_PORT",
            "WEB_PORT",
            "CONVEX_URL",
            "CONVEX_SELF_HOSTED_URL",
            "VITE_CONVEX_URL",
          ]) {
            delete cleanEnv[k];
          }

          // Prepare devenv-root marker (what .envrc does in dev).
          await fs.mkdir(path.join(workspacePath, ".devenv"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(workspacePath, ".devenv/root"),
            workspacePath
          );

          // Trigger enterShell side effects (port probe + .env upsert).
          console.log(`[${wid}] Entering workspace devenv shell...`);
          await $({
            cwd: workspacePath,
            env: cleanEnv,
            quiet: true,
          })`nix develop ${ROOT} --override-input devenv-root "file+file://${workspacePath}/.devenv/root" --command true`;

          // Read allocated ports from the now-populated workspace .env.
          const wsEnv = parseDotenv(await fs.readFile(wsEnvPath, "utf-8"));
          const backendPort = Number(wsEnv.PORT);
          const webPort = Number(wsEnv.WEB_PORT);
          const convexUrl =
            wsEnv.CONVEX_URL ?? `http://127.0.0.1:${backendPort}`;
          if (!(Number.isFinite(backendPort) && Number.isFinite(webPort))) {
            throw new Error(
              `[${wid}] devenv shell did not allocate ports (PORT=${wsEnv.PORT}, WEB_PORT=${wsEnv.WEB_PORT})`
            );
          }
          console.log(
            `[${wid}] Allocated: backend=${backendPort} web=${webPort}`
          );

          // Spawn `devenv up` in the workspace, detached (own process group
          // → one SIGTERM to the group cascades through process-compose).
          const devenvLogPath = path.join(
            os.tmpdir(),
            `crm-e2e-${wid}-devenv.log`
          );
          const devenvLogFd = (await fs.open(devenvLogPath, "w")).fd;
          console.log(`[${wid}] devenv supervisor log: ${devenvLogPath}`);
          const devenv = spawn("devenv", ["up"], {
            cwd: workspacePath,
            env: cleanEnv,
            detached: true,
            stdio: ["ignore", devenvLogFd, devenvLogFd],
          });

          // Wait for the backend to actually answer on its port — this is
          // the point where it's safe to release the boot mutex (next
          // worker's probe will now see this port as bound and skip it).
          await pollUntilReady(
            `${convexUrl}/version`,
            `Convex backend on ${convexUrl}`,
            180_000,
            500
          );
          console.log(`[${wid}] Backend bound on ${backendPort}`);

          return { webPort, convexUrl, devenv };
        });

        resources = { workspacePath, workspaceName, devenv };

        // ── 6. Wait for the rest of the stack ─────────────────────────
        // Admin key is written by the backend process once it has the key.
        await pollUntilFile(
          path.join(workspacePath, ".devenv/state/admin_key"),
          "admin_key",
          60_000,
          500
        );
        // Vite serving.
        await pollUntilReady(
          `http://localhost:${webPort}/`,
          `Vite on ${webPort}`,
          120_000,
          500
        );
        console.log(`[${wid}] Web ready on http://localhost:${webPort}`);

        const m2mSecretKey = process.env.CLERK_M2M_SECRET_KEY;
        if (!m2mSecretKey) {
          throw new Error("CLERK_M2M_SECRET_KEY must be set for E2E tests");
        }

        // eslint-disable-next-line react-hooks/rules-of-hooks
        await use({
          convexUrl,
          m2mSecretKey,
          sessionDir,
          baseURL: `http://localhost:${webPort}`,
        });
      } finally {
        console.log(`[${wid}] Tearing down...`);

        // Group-kill the devenv supervisor — process-compose shuts all its
        // children (convex backend/dashboard/worker/web) and their docker
        // containers via the traps inside each process's exec block.
        if (
          resources.devenv?.pid != null &&
          resources.devenv.exitCode === null
        ) {
          try {
            process.kill(-resources.devenv.pid, "SIGTERM");
          } catch {
            // already gone
          }
          await Promise.race([
            onExit(resources.devenv),
            new Promise((resolve) => setTimeout(resolve, 30_000)),
          ]);
          if (resources.devenv.exitCode === null) {
            try {
              process.kill(-resources.devenv.pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }

        // Belt-and-suspenders: stop any lingering containers from this
        // workspace's compose project (if devenv didn't get to them).
        await $({
          cwd: resources.workspacePath,
          nothrow: true,
          quiet: true,
        })`docker compose -p ${resources.workspaceName} down -v --remove-orphans`;

        // Release the jj workspace, then rm -rf the directory.
        await $({
          cwd: ROOT,
          nothrow: true,
          quiet: true,
        })`jj workspace forget ${resources.workspaceName}`;
        await fs.rm(resources.workspacePath, { recursive: true, force: true });

        console.log(`[${wid}] Cleanup complete`);
      }
    },
    { scope: "worker", timeout: 300_000 },
  ],
});

// biome-ignore lint/performance/noBarrelFile: Playwright fixture pattern requires re-exporting expect alongside test
export { expect } from "@playwright/test";
