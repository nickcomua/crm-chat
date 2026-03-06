import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { GenericContainer } from "testcontainers";

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
  const envLocal = path.join(CONVEX_DIR, ".env.local");
  const envLocalBak = `${envLocal}.e2e-bak`;
  const hadEnvLocal = existsSync(envLocal);
  if (hadEnvLocal) {
    renameSync(envLocal, envLocalBak);
  }

  const { CONVEX_DEPLOYMENT: _, ...cleanEnv } = process.env;

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("bunx", ["convex", ...args], {
      cwd: CONVEX_DIR,
      env: {
        ...cleanEnv,
        CONVEX_SELF_HOSTED_URL: convexUrl,
        CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      },
      stdio: "pipe",
      encoding: "utf-8",
    });
  } finally {
    if (hadEnvLocal) {
      renameSync(envLocalBak, envLocal);
    }
  }
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

      // ── 1. Start Convex backend container ─────────────────────────
      console.log(`[${wid}] Starting Convex backend container...`);
      const container = await new GenericContainer(
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

      // Poll until the backend is responsive
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const res = await fetch(`${convexUrl}/version`);
          if (res.ok) {
            console.log(`[${wid}] Backend ready after ${attempt + 1} attempts`);
            break;
          }
        } catch {
          // not ready yet
        }
        if (attempt === 59) {
          throw new Error("Convex backend not ready after 60s");
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      // ── 1b. Start Restate container ─────────────────────────────
      console.log(`[${wid}] Starting Restate container...`);
      const restateContainer = await new GenericContainer(
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
      convexCmd(["env", "set", "ROBOT_JWKS", jwksDataUri], convexUrl, adminKey);

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
      const worker = spawn(workerBin, [], {
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
      const outDir = path.join(
        os.tmpdir(),
        `crm-e2e-dist-${wid}-${Date.now()}`
      );
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
      const vitePreview = spawn(
        "bunx",
        ["vite", "preview", "--port", String(vitePort), "--outDir", outDir],
        {
          cwd: WEB_DIR,
          env: { ...process.env, VITE_CONVEX_URL: convexUrl },
          stdio: "pipe",
        }
      );

      // Wait for Vite preview to be reachable
      const baseURL = `http://localhost:${vitePort}`;
      const viteDeadline = Date.now() + 15_000;
      while (Date.now() < viteDeadline) {
        try {
          const res = await fetch(baseURL);
          if (res.ok) {
            break;
          }
        } catch {
          // not ready yet
        }
        if (Date.now() >= viteDeadline) {
          throw new Error(`Vite preview not ready after 15s on ${baseURL}`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      console.log(`[${wid}] Vite preview ready at ${baseURL}`);

      // ── Yield to tests ────────────────────────────────────────────
      await use({
        convexUrl,
        robotPrivateKey: privateKeyPem,
        sessionDir,
        baseURL,
      });

      // ── Teardown ──────────────────────────────────────────────────
      console.log(`[${wid}] Tearing down...`);

      // Kill Vite preview
      vitePreview.kill("SIGTERM");

      // Kill crm-worker (SIGTERM → SIGKILL after 5s)
      if (worker.exitCode === null) {
        worker.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            worker.kill("SIGKILL");
            resolve();
          }, 5000);
          worker.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      // Stop containers
      console.log(`[${wid}] Stopping Restate container...`);
      await restateContainer.stop();
      console.log(`[${wid}] Stopping Convex container...`);
      await container.stop();

      // Remove per-worker build directory
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {}

      console.log(`[${wid}] Cleanup complete`);
    },
    { scope: "worker" },
  ],
});

// biome-ignore lint/performance/noBarrelFile: Playwright fixture pattern requires re-exporting expect alongside test
export { expect } from "@playwright/test";
