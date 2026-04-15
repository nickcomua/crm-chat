/* eslint-disable no-empty-pattern */
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { $ } from "zx";
import { env } from "./env.ts";

// Use /bin/sh instead of bash to avoid sourcing ~/.bashrc, which can fail
// in nix environments (e.g. `fnm: command not found`) and mangle PATH.
$.shell = "/bin/sh";
$.prefix = "";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");
const CONVEX_DIR = path.join(ROOT, "bins/convex-backend");

// ---------------------------------------------------------------------------
// Helper: auto-detect Docker socket for OrbStack / Docker Desktop / standard
// ---------------------------------------------------------------------------
function ensureDockerHost(): void {
  if (process.env.DOCKER_HOST) {
    return;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".orbstack/run/docker.sock"),
    "/var/run/docker.sock",
    path.join(home, ".docker/run/docker.sock"),
  ];
  for (const sock of candidates) {
    if (existsSync(sock)) {
      process.env.DOCKER_HOST = `unix://${sock}`;
      console.log(`[fixture] Auto-detected Docker socket: ${sock}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: Wait for a ChildProcess to exit
// ---------------------------------------------------------------------------
function onExit(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode === null) {
      proc.on("exit", (code) => resolve(code));
    } else {
      resolve(proc.exitCode);
    }
  });
}

// ---------------------------------------------------------------------------
// Helper: Gracefully kill a process (SIGTERM → SIGKILL after timeout)
// ---------------------------------------------------------------------------
async function killProcess(
  proc: ChildProcess,
  timeoutMs = 5000
): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }
  proc.kill(); // SIGTERM
  await Promise.race([
    onExit(proc),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, timeoutMs)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Helper: Poll a URL until it responds with 2xx
// ---------------------------------------------------------------------------
async function pollUntilReady(
  url: string,
  label: string,
  maxAttempts: number,
  intervalMs: number
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // not ready yet
    }
    if (attempt === maxAttempts - 1) {
      throw new Error(`${label} not ready after ${maxAttempts} attempts`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Helper: Tear down all resources created during setup
// ---------------------------------------------------------------------------
async function teardownResources(
  wid: string,
  resources: {
    vitePreview?: ChildProcess;
    worker?: ChildProcess;
    container?: StartedTestContainer;
    outDir?: string;
  }
): Promise<void> {
  console.log(`[${wid}] Tearing down...`);

  if (resources.vitePreview) {
    resources.vitePreview.kill();
  }

  if (resources.worker) {
    await killProcess(resources.worker);
  }

  if (resources.container) {
    console.log(`[${wid}] Stopping Convex container...`);
    await resources.container.stop();
  }

  if (resources.outDir) {
    try {
      rmSync(resources.outDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  console.log(`[${wid}] Cleanup complete`);
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
// Worker-scoped fixture: per-worker Convex + crm-worker
// ---------------------------------------------------------------------------
export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Override baseURL so page.goto("/") uses the fixture's Vite preview URL
  baseURL: async ({ workerBackend }, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(workerBackend.baseURL);
  },
  workerBackend: [
    // biome-ignore lint/correctness/noEmptyPattern: playwright whant this
    async ({}, use) => {
      ensureDockerHost();

      const wid = `worker-${process.pid}`;

      // ── 0. Allocate ports ─────────────────────────────────────────
      const ports: number[] = JSON.parse(
        (
          await $({
            quiet: true,
          })`node ${path.join(TESTS_DIR, "find-ports.mjs")} 3`
        ).stdout.trim()
      );
      const [convexPort, sitePort, vitePort] = ports;
      console.log(
        `[${wid}] Ports — convex:${convexPort} site:${sitePort} vite:${vitePort}`
      );

      let container: StartedTestContainer | undefined;
      let worker: ChildProcess | undefined;
      let vitePreview: ChildProcess | undefined;
      let outDir: string | undefined;

      try {
        // ── 1. Start Convex backend container ─────────────────────────
        console.log(`[${wid}] Starting Convex backend container...`);
        container = await new GenericContainer(
          "ghcr.io/get-convex/convex-backend:latest"
        )
          .withExposedPorts(
            { container: 3210, host: convexPort },
            { container: 3211, host: sitePort }
          )
          .withEnvironment({
            INSTANCE_NAME: `test-${wid}`,
            INSTANCE_SECRET:
              "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974",
            CONVEX_CLOUD_ORIGIN: `http://localhost:${convexPort}`,
            CONVEX_SITE_ORIGIN: `http://localhost:${sitePort}`,
            RUST_LOG: "error",
          })
          .withStartupTimeout(120_000)
          .start();

        const convexUrl = `http://localhost:${convexPort}`;
        console.log(
          `[${wid}] Container started at ${convexUrl}, waiting for backend...`
        );

        await pollUntilReady(
          `${convexUrl}/version`,
          "Convex backend",
          60,
          1000
        );
        console.log(`[${wid}] Backend ready`);

        // ── 2. Generate admin key ─────────────────────────────────────
        console.log(`[${wid}] Generating admin key...`);
        const execResult = await container.exec(["./generate_admin_key.sh"]);
        if (execResult.exitCode !== 0) {
          throw new Error(
            `generate_admin_key.sh failed (exit ${execResult.exitCode}): ${execResult.output}`
          );
        }
        const adminKey = execResult.output
          .trim()
          .split("\n")
          .filter(Boolean)
          .pop()
          ?.trim();
        if (!adminKey) {
          throw new Error("No admin key in generate_admin_key.sh output");
        }
        console.log(`[${wid}] Admin key: ${adminKey.slice(0, 30)}...`);

        // ── 3. Read Clerk M2M secret key ──────────────────────────────
        const m2mSecretKey = process.env.CLERK_M2M_SECRET_KEY;
        if (!m2mSecretKey) {
          throw new Error("CLERK_M2M_SECRET_KEY must be set for E2E tests");
        }
        console.log(`[${wid}] Clerk M2M key available`);

        // ── 4. Set Convex env vars and deploy ─────────────────────────
        // Write a temp env file so `bun x convex` uses our test backend
        // instead of .env.local (which has CONVEX_DEPLOYMENT for dev).
        const convexEnvFile = path.join(
          os.tmpdir(),
          `crm-e2e-convex-env-${wid}-${Date.now()}`
        );
        writeFileSync(
          convexEnvFile,
          `CONVEX_SELF_HOSTED_URL=${convexUrl}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`
        );
        const convexEnv = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        };
        const convex$ = $({ cwd: CONVEX_DIR, env: convexEnv });

        console.log(`[${wid}] Setting Convex env vars...`);
        await convex$`bun x convex env set --env-file ${convexEnvFile} CLERK_JWT_ISSUER_DOMAIN https://noted-rabbit-14.clerk.accounts.dev`;

        console.log(`[${wid}] Deploying Convex functions...`);
        await convex$`bun x convex deploy --env-file ${convexEnvFile}`;
        console.log(`[${wid}] Deploy complete`);

        // ── 5. Create session directory ───────────────────────────────
        const sessionDir = path.join(
          os.tmpdir(),
          `crm-e2e-sessions-${wid}-${Date.now()}`
        );
        mkdirSync(sessionDir, { recursive: true });

        // ── 6. Spawn crm-worker ───────────────────────────────────────
        const workerBin = process.env.E2E_WORKER_BIN;
        if (!workerBin) {
          throw new Error(
            "E2E_WORKER_BIN not set — globalSetup should build and set it"
          );
        }

        const workerLogPath = path.join(
          os.tmpdir(),
          `crm-e2e-${wid}-${Date.now()}.log`
        );
        console.log(`[${wid}] Worker logs: ${workerLogPath}`);
        const workerLogFd = openSync(workerLogPath, "w");
        worker = spawn(workerBin, [], {
          env: {
            PATH: process.env.PATH ?? "",
            // Worker uses secretspec, which defaults to the dotenv provider.
            // In tests we inject secrets directly as env vars — tell
            // secretspec to read from the environment instead.
            SECRETSPEC_PROVIDER: "env",
            CONVEX_URL: convexUrl,
            CLERK_M2M_SECRET_KEY: m2mSecretKey,
            TG_ID: env.TG_ID,
            TG_HASH: env.TG_HASH,
            TG_SESSION_DIR: sessionDir,
            SCAN_REFRESH_SECS: "5",
            RUST_LOG: "debug,crm_worker=debug",
          },
          stdio: ["ignore", workerLogFd, workerLogFd],
        });

        // The worker now subscribes to Convex directly and has no readiness
        // endpoint — wait a couple of seconds for its startup log, then
        // assume ready. If it exited early, bail.
        await new Promise((r) => setTimeout(r, 2000));
        if (worker.exitCode !== null) {
          throw new Error(
            `crm-worker exited prematurely (code ${worker.exitCode})`
          );
        }
        console.log(`[${wid}] crm-worker running (PID ${worker.pid})`);

        // ── 7. Build and start Vite preview ───────────────────────────
        // Each worker builds to its own temp directory so parallel workers
        // don't overwrite each other's VITE_CONVEX_URL baked into the bundle.
        outDir = path.join(os.tmpdir(), `crm-e2e-dist-${wid}-${Date.now()}`);
        console.log(`[${wid}] Building frontend to ${outDir}...`);
        await $({
          cwd: WEB_DIR,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            VITE_CONVEX_URL: convexUrl,
            VITE_CLERK_PUBLISHABLE_KEY: env.VITE_CLERK_PUBLISHABLE_KEY,
            VITE_TEST_USERNAME: env.TEST_CLERK_USERNAME,
            VITE_TEST_PASSWORD: env.TEST_CLERK_PASSWORD,
          },
        })`bun x vite build --outDir ${outDir}`;

        console.log(`[${wid}] Starting Vite preview on port ${vitePort}...`);
        vitePreview = spawn(
          "bun",
          [
            "x",
            "vite",
            "preview",
            "--port",
            String(vitePort),
            "--outDir",
            outDir,
          ],
          {
            cwd: WEB_DIR,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              VITE_CONVEX_URL: convexUrl,
            },
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        const baseURL = `http://localhost:${vitePort}`;
        await pollUntilReady(baseURL, `Vite preview on ${baseURL}`, 50, 300);
        console.log(`[${wid}] Vite preview ready at ${baseURL}`);

        // ── Yield to tests ────────────────────────────────────────────
        // eslint-disable-next-line react-hooks/rules-of-hooks
        await use({
          convexUrl,
          m2mSecretKey,
          sessionDir,
          baseURL,
        });
      } finally {
        // Runs after tests complete (normal path) AND if any setup step
        // throws, ensuring containers and processes are never leaked.
        await teardownResources(wid, {
          vitePreview,
          worker,
          container,
          outDir,
        });
      }
    },
    { scope: "worker", timeout: 180_000 },
  ],
});

// biome-ignore lint/performance/noBarrelFile: Playwright fixture pattern requires re-exporting expect alongside test
export { expect } from "@playwright/test";
