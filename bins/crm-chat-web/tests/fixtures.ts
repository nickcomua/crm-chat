/* eslint-disable no-empty-pattern */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { $ } from "zx";

/**
 * Reproduce flake.nix's docker-compose project name so teardown can target
 * the right compose project without calling out to `nix eval`.
 *
 * Must stay in sync with flake.nix:
 *   env.COMPOSE_PROJECT_NAME = "crm-chat-${
 *     builtins.substring 0 8 (builtins.hashString "sha256" config.devenv.root)
 *   }";
 */
function composeProjectFor(workspacePath: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex");
  return `crm-chat-${hash.slice(0, 8)}`;
}

$.shell = "/bin/sh";
$.prefix = "";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");

// ---------------------------------------------------------------------------
// Shared mutex — serializes the "create workspace + start devenv up + wait
// for backend to bind" phase across parallel Playwright workers. Ports are
// deterministic (hash-derived per-workspace offset in flake.nix), so strict
// serialization is no longer required for correctness, but it still cheaply
// guards against concurrent docker-compose network-setup races.
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

const PERSIST = process.env.E2E_PERSIST_WORKSPACE === "1";

async function isWorkspaceHealthy(workspacePath: string): Promise<boolean> {
  const wsEnvPath = path.join(workspacePath, ".env");
  if (!existsSync(wsEnvPath)) {
    return false;
  }
  try {
    const wsEnv = parseDotenv(await fs.readFile(wsEnvPath, "utf-8"));
    const backendPort = Number(wsEnv.PORT);
    const webPort = Number(wsEnv.WEB_PORT);
    const convexUrl =
      wsEnv.CONVEX_URL ?? `http://127.0.0.1:${backendPort}`;
    if (!(Number.isFinite(backendPort) && Number.isFinite(webPort))) {
      return false;
    }
    // Check Convex backend.
    const backendRes = await fetch(`${convexUrl}/version`);
    if (!backendRes.ok) {
      return false;
    }
    // Check Vite dev server can actually serve a JS module (not just the
    // SPA HTML fallback). A stale/leaked Vite process often returns 500 or
    // an HTML error overlay for .tsx modules while still answering 200 for /.
    const moduleRes = await fetch(
      `http://localhost:${webPort}/src/routes/sign-in.tsx`
    );
    if (!moduleRes.ok) {
      return false;
    }
    const contentType = moduleRes.headers.get("content-type") ?? "";
    if (!contentType.includes("javascript")) {
      return false;
    }
    // Verify the Vite server is serving from the correct workspace, not a
    // leaked process from another workspace squatting on the same port.
    const idRes = await fetch(
      `http://localhost:${webPort}/.workspace-id`
    );
    if (!idRes.ok) {
      return false;
    }
    const idText = await idRes.text();
    if (idText.trim() !== path.basename(workspacePath)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function cleanupStaleWorkspace(
  workspacePath: string,
  workspaceName: string
): Promise<void> {
  // 1. Kill any lingering devenv process group from a previous run.
  const pidFile = path.join(workspacePath, ".devenv", "e2e-devenv.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf-8"));
    if (Number.isFinite(pid)) {
      try {
        process.kill(-pid, "SIGTERM");
        // Give it a moment to cascade through process-compose.
        await new Promise((r) => setTimeout(r, 5_000));
      } catch {
        // already gone
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  // 2. Stop docker containers for this workspace's compose project.
  const composeProject = composeProjectFor(workspacePath);
  await $({
    cwd: ROOT,
    nothrow: true,
    quiet: true,
  })`docker compose -p ${composeProject} down -v --remove-orphans`;

  // 3. Forget the jj workspace and remove the directory.
  await $({
    cwd: ROOT,
    nothrow: true,
    quiet: true,
  })`jj workspace forget ${workspaceName}`;
  await $({
    nothrow: true,
    quiet: true,
  })`sudo rm -rf ${workspacePath}`;
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

// ---------------------------------------------------------------------------
// Poll for a log file to contain a marker string.
// ---------------------------------------------------------------------------
async function pollUntilLogContains(
  filePath: string,
  marker: string,
  label: string,
  timeoutMs: number,
  intervalMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath) && readFileSync(filePath, "utf-8").includes(marker)) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `${label}: log ${filePath} never contained "${marker}" in ${timeoutMs}ms`
  );
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
    // Optional: only tests that talk to Convex as a worker-role (via
    // helpers.getRobotClient) need this. Smoke tests skip it. The raw
    // value comes from process.env, which Playwright worker subprocesses
    // inherit from the runner; it is NOT loaded from .env again inside
    // the fixture, so a runner invoked outside `secretspec run` will get
    // undefined here — that's fine, the tests that need it will fail
    // themselves when they try to use it.
    m2mSecretKey: string | undefined;
    sessionDir: string;
    baseURL: string;
  };
}

// ---------------------------------------------------------------------------
// Worker-scoped fixture — one independent devenv-up per Playwright worker.
//
// Per-worker isolation is provided by the root flake's `workspace-new` devenv
// script (see flake.nix), which:
//   * `jj workspace add -r @` so the new workspace inherits the current
//     working-copy snapshot (flake.nix edits, docker-compose tweaks, WIP)
//   * Copies .env, bins/*/node_modules, and target/ (minus docker-mounted
//     persistent volumes) so devenv up doesn't cold-build the Rust worker
//   * Seeds <workspace>/.devenv/root so `nix develop` works without direnv
//
// The flake derives a deterministic per-workspace port offset from a hash
// of the workspace root path (processes.*.ports.*.allocate = base + offset),
// and COMPOSE_PROJECT_NAME = "crm-chat-<hash>" so docker container names
// never collide. enterShell mirrors the offset ports into <workspace>/.env.
//
// The "create workspace + start devenv up + wait for backend to bind" phase
// is serialized via the module-level `bootQueue` mutex; tests themselves
// still run fully in parallel.
// ---------------------------------------------------------------------------
export const test = base.extend<TestFixtures, WorkerFixtures>({
  baseURL: async ({ workerBackend }, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(workerBackend.baseURL);
  },
  workerBackend: [
    // biome-ignore lint/correctness/noEmptyPattern: playwright fixture pattern
    async ({}, use) => {
      const workerIndex = process.env.TEST_WORKER_INDEX ?? "0";
      const repoHash = createHash("sha256").update(ROOT).digest("hex").slice(0, 8);
      const wid = PERSIST ? `w${workerIndex}` : `${process.pid}-${Date.now()}`;
      const workspacePath = PERSIST
        ? path.join(os.tmpdir(), `crm-e2e-${repoHash}-w${workerIndex}`)
        : path.join(os.tmpdir(), `crm-e2e-${wid}`);
      const workspaceName = path.basename(workspacePath);

      let resources: {
        workspacePath: string;
        workspaceName: string;
        devenv?: ChildProcess;
      } = { workspacePath, workspaceName };

      const skipTeardown = PERSIST;

      try {
        // ── 0. Reuse existing healthy persistent workspace ─────────────
        if (PERSIST && (await isWorkspaceHealthy(workspacePath))) {
          console.log(
            `[${wid}] Reusing healthy workspace ${workspacePath}`
          );
          const wsEnv = parseDotenv(
            await fs.readFile(path.join(workspacePath, ".env"), "utf-8")
          );
          const webPort = Number(wsEnv.WEB_PORT);
          const backendPort = Number(wsEnv.PORT);
          const convexUrl =
            wsEnv.CONVEX_URL ?? `http://127.0.0.1:${backendPort}`;
          const sessionDir = path.join(
            workspacePath,
            "target/crm-worker-data"
          );
          await use({
            convexUrl,
            m2mSecretKey: process.env.CLERK_M2M_SECRET_KEY,
            sessionDir,
            baseURL: `http://localhost:${webPort}`,
          });
          return;
        }

        // If persistent but directory exists and is unhealthy, clean up stale.
        if (PERSIST && existsSync(workspacePath)) {
          console.log(`[${wid}] Stale workspace detected, cleaning up...`);
          await cleanupStaleWorkspace(workspacePath, workspaceName);
        }

        // ── 1-2. Serialized boot: spawn a jj workspace via the root flake's
        //          `workspace-new` script, then start `devenv up`, then wait
        //          for the backend to bind. ──────────────────────────────
        const { webPort, convexUrl, sessionDir, devenv } = await serializeBoot(
          async () => {
            // `workspace-new` lives in the root flake's dev shell. Invoke it
            // via `nix develop --command`, so the caller doesn't need to be
            // inside the dev shell (`bun x playwright test` from outside).
            console.log(
              `[${wid}] Creating jj workspace at ${workspacePath}...`
            );
            await $({
              cwd: ROOT,
              quiet: true,
            })`nix develop --accept-flake-config --override-input devenv-root file+file://${ROOT}/.devenv/root --command workspace-new ${workspacePath}`;

            // Write a workspace identity marker so isWorkspaceHealthy can
            // detect leaked Vite processes from other workspaces squatting
            // on the same port.
            const webPublicDir = path.join(
              workspacePath,
              "bins/crm-chat-web/public"
            );
            await fs.mkdir(webPublicDir, { recursive: true });
            await fs.writeFile(
              path.join(webPublicDir, ".workspace-id"),
              workspaceName
            );

            // Append test-only overrides on top of the .env seeded from ROOT.
            // enterShell has NOT run in the new workspace yet, so it will
            // upsert the per-workspace PORT/WEB_PORT/etc. on top of these
            // when `devenv up` boots below.
            const wsEnvPath = path.join(workspacePath, ".env");
            const sessionDir = path.join(
              workspacePath,
              "target/crm-worker-data"
            );
            await fs.mkdir(sessionDir, { recursive: true });
            await fs.appendFile(
              wsEnvPath,
              `\nTG_SESSION_DIR=${sessionDir}\nSCAN_REFRESH_SECS=5\n`
            );

            // Pre-enter the workspace shell once so enterShell runs its
            // port-upsert against the (freshly copied) .env. This makes the
            // port values visible to us BEFORE devenv up starts, so we know
            // which URL to poll.
            console.log(`[${wid}] Priming devenv shell (enterShell)...`);
            await $({
              cwd: workspacePath,
              quiet: true,
            })`nix develop --accept-flake-config --override-input devenv-root file+file://${workspacePath}/.devenv/root --command true`;

            const wsEnv = parseDotenv(await fs.readFile(wsEnvPath, "utf-8"));
            const backendPort = Number(wsEnv.PORT);
            const webPort = Number(wsEnv.WEB_PORT);
            const convexUrl =
              wsEnv.CONVEX_URL ?? `http://127.0.0.1:${backendPort}`;
            if (!(Number.isFinite(backendPort) && Number.isFinite(webPort))) {
              throw new Error(
                `[${wid}] enterShell did not populate ports (PORT=${wsEnv.PORT}, WEB_PORT=${wsEnv.WEB_PORT})`
              );
            }
            console.log(
              `[${wid}] Allocated: backend=${backendPort} web=${webPort}`
            );

            // Spawn `devenv up` detached (own process group → one SIGTERM
            // to the group cascades through process-compose). -t=false so
            // there's no TUI (we're in a non-interactive test runner).
            const devenvLogPath = path.join(
              os.tmpdir(),
              `crm-e2e-${wid}-devenv.log`
            );
            const devenvLogFd = (await fs.open(devenvLogPath, "w")).fd;
            console.log(`[${wid}] devenv supervisor log: ${devenvLogPath}`);
            const devenv = spawn(
              "nix",
              [
                "develop",
                "--accept-flake-config",
                "--override-input",
                "devenv-root",
                `file+file://${workspacePath}/.devenv/root`,
                "--command",
                "devenv",
                "up",
                "-t=false",
              ],
              {
                cwd: workspacePath,
                detached: true,
                stdio: ["ignore", devenvLogFd, devenvLogFd],
              }
            );

            // Write PID so stale cleanup can target this process group later.
            const devenvPidFile = path.join(
              workspacePath,
              ".devenv",
              "e2e-devenv.pid"
            );
            await fs.mkdir(path.dirname(devenvPidFile), { recursive: true });
            await fs.writeFile(devenvPidFile, String(devenv.pid));

            // Wait for the backend to actually answer on its port.
            await pollUntilReady(
              `${convexUrl}/version`,
              `Convex backend on ${convexUrl}`,
              180_000,
              500
            );
            console.log(`[${wid}] Backend bound on ${backendPort}`);

            return { webPort, convexUrl, sessionDir, devenv };
          }
        );

        resources = { workspacePath, workspaceName, devenv };

        // ── 3. Wait for the rest of the stack ─────────────────────────
        // Admin key is written by the backend process once it has the key.
        await pollUntilFile(
          path.join(workspacePath, ".devenv/state/admin_key"),
          "admin_key",
          60_000,
          500
        );
        // Wait for `convex dev` to push functions + auth config. Without
        // this, the first mutation a test makes races the deploy and returns
        // `NoAuthProvider: ... (no providers configured)` because
        // convex/auth.config.ts hasn't been synced yet.
        await pollUntilLogContains(
          path.join(workspacePath, ".devenv/state/logs/convex-backend.log"),
          "Convex functions ready!",
          "convex dev initial deploy",
          120_000,
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

        // crm-worker has finished its cold build and subscribed to pending
        // work. Otherwise tests that register a client can run before the
        // worker picks it up, leaving the UI in "No chats synced yet" and
        // tripping selectors that expect chat rows.
        await pollUntilLogContains(
          path.join(workspacePath, ".devenv/state/logs/crm-worker.log"),
          "crm-worker ready",
          "crm-worker cold build + subscribe",
          300_000,
          1000
        );
        console.log(`[${wid}] crm-worker ready`);

        // eslint-disable-next-line react-hooks/rules-of-hooks
        await use({
          convexUrl,
          m2mSecretKey: process.env.CLERK_M2M_SECRET_KEY,
          sessionDir,
          baseURL: `http://localhost:${webPort}`,
        });
      } finally {
        if (skipTeardown) {
          console.log(
            `[${wid}] Persisting workspace for reuse: ${workspacePath}`
          );
          return;
        }

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
        // workspace's compose project (devenv's EXIT trap stops backend on
        // SIGTERM, but doesn't `down -v` — that cleans up stopped containers,
        // the network, and the fresh-per-workspace persistent volumes).
        const composeProject = composeProjectFor(resources.workspacePath);
        await $({
          cwd: resources.workspacePath,
          nothrow: true,
          quiet: true,
        })`docker compose -p ${composeProject} down -v --remove-orphans`;

        // Release the jj workspace, then rm -rf the directory (sudo because
        // docker containers create root-owned files under target/crm-chat-data
        // and target/crm-worker-data).
        await $({
          cwd: ROOT,
          nothrow: true,
          quiet: true,
        })`jj workspace forget ${resources.workspaceName}`;
        await $({
          nothrow: true,
          quiet: true,
        })`sudo rm -rf ${resources.workspacePath}`;

        console.log(`[${wid}] Cleanup complete`);
      }
    },
    { scope: "worker", timeout: 600_000 },
  ],
});

// biome-ignore lint/performance/noBarrelFile: Playwright fixture pattern requires re-exporting expect alongside test
export { expect } from "@playwright/test";
