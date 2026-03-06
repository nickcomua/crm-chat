import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

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
// Helper: Load .env from repo root (only sets vars not already in process.env)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helper: Run `bunx convex <args>` against a test backend
// ---------------------------------------------------------------------------
function convexCmd(args: string[], convexUrl: string, adminKey: string): void {
  // Strip CONVEX_DEPLOYMENT and any existing CONVEX_SELF_HOSTED_* from the
  // inherited env so our explicit values always win — even if .env.local in
  // CONVEX_DIR sets them.  The subprocess env vars we pass below take
  // precedence over anything the Convex CLI reads from .env.local, so we no
  // longer need the old rename-and-restore dance (which raced when multiple
  // workers called this in parallel).
  const {
    CONVEX_DEPLOYMENT: _cd,
    CONVEX_SELF_HOSTED_URL: _csu,
    CONVEX_SELF_HOSTED_ADMIN_KEY: _csa,
    ...cleanEnv
  } = process.env;

  const result = spawnSync("bunx", ["convex", ...args], {
    cwd: CONVEX_DIR,
    env: {
      ...cleanEnv,
      CONVEX_SELF_HOSTED_URL: convexUrl,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    },
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(
      `bunx convex ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr}`
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: Poll Restate admin API until the worker deployment is registered
// ---------------------------------------------------------------------------
async function waitForWorkerReady(
  worker: ChildProcess,
  adminPort: number
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) {
      throw new Error(
        `crm-worker exited prematurely (code ${worker.exitCode})`
      );
    }
    try {
      const resp = await fetch(`http://localhost:${adminPort}/deployments`);
      if (resp.ok) {
        const body = (await resp.json()) as { deployments?: unknown[] };
        if (body.deployments && body.deployments.length > 0) {
          // Extra wait for the TaskOrchestrator to start its subscription loop
          await new Promise((r) => setTimeout(r, 2000));
          return;
        }
      }
    } catch {
      // Restate admin not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("crm-worker did not register with Restate within 30s");
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
// Helper: Gracefully kill a child process (SIGTERM → SIGKILL after timeout)
// ---------------------------------------------------------------------------
async function killProcess(
  proc: ChildProcess,
  timeoutMs = 5000
): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: Tear down all resources created during setup
// ---------------------------------------------------------------------------
async function teardownResources(
  wid: string,
  resources: {
    vitePreview?: ChildProcess;
    worker?: ChildProcess;
    restateContainer?: StartedTestContainer;
    container?: StartedTestContainer;
    outDir?: string;
  }
): Promise<void> {
  console.log(`[${wid}] Tearing down...`);

  if (resources.vitePreview) {
    resources.vitePreview.kill("SIGTERM");
  }

  if (resources.worker) {
    await killProcess(resources.worker);
  }

  if (resources.restateContainer) {
    console.log(`[${wid}] Stopping Restate container...`);
    await resources.restateContainer.stop();
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
    robotPrivateKey: string;
    sessionDir: string;
    baseURL: string;
  };
}

// ---------------------------------------------------------------------------
// Worker-scoped fixture: per-worker Convex + Restate + crm-worker
// ---------------------------------------------------------------------------
export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Override baseURL so page.goto("/") uses the fixture's Vite preview URL
  baseURL: async ({ workerBackend }, use) => {
    await use(workerBackend.baseURL);
  },
  workerBackend: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture API requires destructured arg
    async ({}, use) => {
      loadEnvFile();
      ensureDockerHost();

      const wid = `worker-${process.pid}`;

      // ── 0. Allocate ports ─────────────────────────────────────────
      const ports: number[] = JSON.parse(
        spawnSync("node", [path.join(TESTS_DIR, "find-ports.mjs"), "6"], {
          encoding: "utf-8",
        }).stdout.trim()
      );
      const [
        convexPort,
        sitePort,
        restateIngressPort,
        restateAdminPort,
        workerServicePort,
        vitePort,
      ] = ports;
      console.log(
        `[${wid}] Ports — convex:${convexPort} site:${sitePort} restate-ingress:${restateIngressPort} restate-admin:${restateAdminPort} worker:${workerServicePort} vite:${vitePort}`
      );

      // Track resources so the finally block can clean up after a
      // partial setup failure (e.g. container started but deploy throws).
      let container: StartedTestContainer | undefined;
      let restateContainer: StartedTestContainer | undefined;
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

        // ── 1b. Start Restate container ─────────────────────────────
        console.log(`[${wid}] Starting Restate container...`);
        restateContainer = await new GenericContainer(
          "docker.io/restatedev/restate:1.3"
        )
          .withExposedPorts(
            { container: 8080, host: restateIngressPort },
            { container: 9070, host: restateAdminPort }
          )
          .withEnvironment({
            RESTATE_OBSERVABILITY__LOG__FORMAT: "json",
          })
          .withStartupTimeout(60_000)
          .start();

        console.log(
          `[${wid}] Restate started (ingress:${restateIngressPort}, admin:${restateAdminPort})`
        );

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

        // ── 3. Generate RSA keypair for robot auth ────────────────────
        console.log(`[${wid}] Generating robot RSA keypair...`);
        const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
        });
        const privateKeyPem = privateKey.export({
          type: "pkcs8",
          format: "pem",
        }) as string;
        const jwk = publicKey.export({ format: "jwk" });
        const jwks = {
          keys: [
            {
              kty: "RSA",
              use: "sig",
              alg: "RS256",
              kid: "e2e-robot-key",
              n: jwk.n,
              e: jwk.e,
            },
          ],
        };
        const jwksB64 = Buffer.from(JSON.stringify(jwks)).toString("base64");
        const jwksDataUri = `data:application/json;base64,${jwksB64}`;
        console.log(`[${wid}] Robot keypair generated`);

        // ── 4. Deploy Convex functions ────────────────────────────────
        console.log(`[${wid}] Setting Convex env vars...`);
        convexCmd(
          [
            "env",
            "set",
            "CLERK_JWT_ISSUER_DOMAIN",
            "https://noted-rabbit-14.clerk.accounts.dev",
          ],
          convexUrl,
          adminKey
        );
        convexCmd(
          ["env", "set", "ROBOT_JWKS", jwksDataUri],
          convexUrl,
          adminKey
        );

        console.log(`[${wid}] Deploying Convex functions...`);
        convexCmd(["deploy"], convexUrl, adminKey);
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
            PATH: process.env.PATH,
            CONVEX_URL: convexUrl,
            ROBOT_JWT_PRIVATE_KEY: privateKeyPem,
            ROBOT_ID: "e2e-robot",
            ROBOT_KID: "e2e-robot-key",
            TG_ID: process.env.TG_ID,
            TG_HASH: process.env.TG_HASH,
            TG_SESSION_DIR: sessionDir,
            RESTATE_SERVICE_PORT: String(workerServicePort),
            RESTATE_ADMIN_URL: `http://localhost:${restateAdminPort}`,
            RESTATE_INGRESS_URL: `http://localhost:${restateIngressPort}`,
            SCAN_REFRESH_SECS: "5",
            RUST_LOG: "debug,crm_worker=debug",
          },
          stdio: ["ignore", workerLogFd, workerLogFd],
        });

        await waitForWorkerReady(worker, restateAdminPort);
        console.log(`[${wid}] crm-worker running (PID ${worker.pid})`);

        // ── 7. Build and start Vite preview ───────────────────────────
        // Each worker builds to its own temp directory so parallel workers
        // don't overwrite each other's VITE_CONVEX_URL baked into the bundle.
        outDir = path.join(os.tmpdir(), `crm-e2e-dist-${wid}-${Date.now()}`);
        console.log(`[${wid}] Building frontend to ${outDir}...`);
        const buildResult = spawnSync(
          "bunx",
          ["vite", "build", "--outDir", outDir],
          {
            cwd: WEB_DIR,
            env: {
              ...process.env,
              VITE_CONVEX_URL: convexUrl,
              // Map TEST_CLERK_* to VITE_TEST_* so AutoSignIn activates
              VITE_TEST_USERNAME: process.env.TEST_CLERK_USERNAME ?? "",
              VITE_TEST_PASSWORD: process.env.TEST_CLERK_PASSWORD ?? "",
            },
            stdio: "pipe",
            encoding: "utf-8",
          }
        );
        if (buildResult.status !== 0) {
          throw new Error(
            `vite build failed:\n${buildResult.stdout}\n${buildResult.stderr}`
          );
        }

        console.log(`[${wid}] Starting Vite preview on port ${vitePort}...`);
        vitePreview = spawn(
          "bunx",
          ["vite", "preview", "--port", String(vitePort), "--outDir", outDir],
          {
            cwd: WEB_DIR,
            env: { ...process.env, VITE_CONVEX_URL: convexUrl },
            stdio: "pipe",
          }
        );

        const baseURL = `http://localhost:${vitePort}`;
        await pollUntilReady(baseURL, `Vite preview on ${baseURL}`, 50, 300);
        console.log(`[${wid}] Vite preview ready at ${baseURL}`);

        // ── Yield to tests ────────────────────────────────────────────
        await use({
          convexUrl,
          robotPrivateKey: privateKeyPem,
          sessionDir,
          baseURL,
        });
      } finally {
        // Runs after tests complete (normal path) AND if any setup step
        // throws, ensuring containers and processes are never leaked.
        await teardownResources(wid, {
          vitePreview,
          worker,
          restateContainer,
          container,
          outDir,
        });
      }
    },
    { scope: "worker" },
  ],
});

// biome-ignore lint/performance/noBarrelFile: Playwright fixture pattern requires re-exporting expect alongside test
export { expect } from "@playwright/test";
