import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");
const CONVEX_DIR = path.join(ROOT, "bins/convex-backend");
const WORKER_BIN = path.join(ROOT, "target/debug/crm-worker");


/** Auto-detect Docker socket for OrbStack/Docker Desktop/standard Docker. */
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
      console.log(`[e2e] Auto-detected Docker socket: ${sock}`);
      return;
    }
  }
}

declare global {
  var __E2E: {
    container: StartedTestContainer;
    restateContainer: StartedTestContainer;
    worker?: ChildProcess;
  };
}

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

/** Run `bunx convex <args>` against the test backend. */
function convexCmd(args: string[], convexUrl: string, adminKey: string): void {
  // The Convex CLI reads .env.local from CWD, which may contain CONVEX_DEPLOYMENT
  // that conflicts with CONVEX_SELF_HOSTED_URL. Temporarily hide it.
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

/**
 * Poll the Restate admin API until the worker's deployment is registered.
 * Fails after 30s if the worker doesn't register or crashes.
 */
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
      const resp = await fetch(
        `http://localhost:${adminPort}/deployments`
      );
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

export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  ensureDockerHost();

  // Validate required env vars (typed validation happens in tests/env.ts)
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

  // ── 0. Read pre-allocated ports ─────────────────────────────────
  // Ports are allocated in playwright.config.ts (at config eval time) because
  // Playwright starts webServer BEFORE globalSetup — the Vite build needs
  // VITE_CONVEX_URL baked in at build time.
  const convexPort = Number(process.env.E2E_CONVEX_PORT);
  const sitePort = Number(process.env.E2E_SITE_PORT);
  const restateIngressPort = Number(process.env.E2E_RESTATE_INGRESS_PORT);
  const restateAdminPort = Number(process.env.E2E_RESTATE_ADMIN_PORT);
  const workerServicePort = Number(process.env.E2E_WORKER_PORT);
  if (
    !convexPort ||
    !sitePort ||
    !restateIngressPort ||
    !restateAdminPort ||
    !workerServicePort
  ) {
    throw new Error(
      "[e2e] E2E_*_PORT env vars not set — playwright.config.ts should allocate them"
    );
  }
  console.log(
    `[e2e] Using ports — convex:${convexPort} site:${sitePort} restate-ingress:${restateIngressPort} restate-admin:${restateAdminPort} worker:${workerServicePort}`
  );

  // ── 1. Start Convex backend container ─────────────────────────────
  console.log("[e2e] Starting Convex backend container...");

  const container = await new GenericContainer(
    "ghcr.io/get-convex/convex-backend:latest"
  )
    .withExposedPorts(
      { container: 3210, host: convexPort },
      { container: 3211, host: sitePort }
    )
    .withEnvironment({
      INSTANCE_NAME: "test-instance",
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
    `[e2e] Container started at ${convexUrl}, waiting for backend...`
  );

  // Poll until the backend is responsive
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${convexUrl}/version`);
      if (res.ok) {
        console.log(`[e2e] Backend ready after ${attempt + 1} attempts`);
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

  // ── 1b. Start Restate container ───────────────────────────────────
  console.log("[e2e] Starting Restate container...");

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
    `[e2e] Restate container started (ingress: ${restateIngressPort}, admin: ${restateAdminPort})`
  );

  // ── 2. Generate admin key inside the container ────────────────────
  console.log("[e2e] Generating admin key...");
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
  console.log(`[e2e] Admin key: ${adminKey.slice(0, 30)}...`);

  // ── 3. Generate RSA keypair for robot auth ────────────────────────
  console.log("[e2e] Generating robot RSA keypair...");
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
  console.log("[e2e] Robot keypair generated");

  // ── 4. Deploy Convex functions ────────────────────────────────────
  console.log("[e2e] Installing Convex dependencies...");
  const bunResult = spawnSync("bun", ["install"], {
    cwd: CONVEX_DIR,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (bunResult.status !== 0) {
    throw new Error(`bun install failed:\n${bunResult.stderr}`);
  }

  console.log("[e2e] Setting Convex env vars...");
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

  console.log("[e2e] Deploying Convex functions...");
  convexCmd(["deploy"], convexUrl, adminKey);
  console.log("[e2e] Deploy complete");

  // ── 5. Build and start crm-worker ─────────────────────────────────
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

  // ── 5b. Create session directory for the worker ───────────────────
  const sessionDir = path.join(os.tmpdir(), `crm-e2e-sessions-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  process.env.E2E_SESSION_DIR = sessionDir;

  console.log("[e2e] Starting crm-worker...");
  const workerLogPath = path.join(
    os.tmpdir(),
    `crm-e2e-worker-${Date.now()}.log`
  );
  process.env.E2E_WORKER_LOG = workerLogPath;
  console.log(`[e2e] Worker logs: ${workerLogPath}`);
  const workerLogFd = openSync(workerLogPath, "w");
  const worker = spawn(WORKER_BIN, [], {
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

  // Worker self-registers with Restate and bootstraps the TaskOrchestrator.
  await waitForWorkerReady(worker, restateAdminPort);
  console.log(`[e2e] crm-worker running (PID ${worker.pid})`);

  // ── 6. Set environment for test workers ───────────────────────────
  process.env.E2E_CONVEX_URL = convexUrl;
  process.env.E2E_ROBOT_PRIVATE_KEY = privateKeyPem;

  // Store references for teardown
  globalThis.__E2E = { container, restateContainer, worker };
}
