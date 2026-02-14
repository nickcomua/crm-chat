import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TESTS_DIR, "..");
const ROOT = path.resolve(WEB_DIR, "../..");
const CONVEX_DIR = path.join(ROOT, "bins/convex-backend");
const WORKER_BIN = path.join(ROOT, "target/debug/crm-worker");

// Fixed ports — must match playwright.config.ts
const CONVEX_HOST_PORT = 13_210;
const SITE_HOST_PORT = 13_211;
const RESTATE_INGRESS_PORT = 18_080;
const RESTATE_ADMIN_PORT = 19_070;
const WORKER_SERVICE_PORT = 19_080;

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

/** Run `npx convex <args>` against the test backend. */
function convexCmd(args: string[], convexUrl: string, adminKey: string): void {
  const result = spawnSync("npx", ["convex", ...args], {
    cwd: CONVEX_DIR,
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: convexUrl,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    },
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `npx convex ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr}`
    );
  }
}

/** Register crm-worker with Restate admin API. */
async function registerWorkerWithRestate(): Promise<void> {
  const adminUrl = `http://localhost:${RESTATE_ADMIN_PORT}`;
  const workerUrl = `http://host.docker.internal:${WORKER_SERVICE_PORT}`;

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`${adminUrl}/deployments`);
      if (res.ok) {
        break;
      }
    } catch {
      // not ready yet
    }
    if (attempt === 29) {
      throw new Error("Restate admin API not ready after 30s");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const res = await fetch(`${adminUrl}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: workerUrl }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to register worker with Restate (${res.status}): ${body}`
    );
  }
  console.log("[e2e] Registered crm-worker with Restate");
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

  // ── 1. Start Convex backend container ─────────────────────────────
  console.log("[e2e] Starting Convex backend container...");

  const container = await new GenericContainer(
    "ghcr.io/get-convex/convex-backend:latest"
  )
    .withExposedPorts(
      { container: 3210, host: CONVEX_HOST_PORT },
      { container: 3211, host: SITE_HOST_PORT }
    )
    .withEnvironment({
      INSTANCE_NAME: "test-instance",
      INSTANCE_SECRET:
        "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974",
      CONVEX_CLOUD_ORIGIN: `http://localhost:${CONVEX_HOST_PORT}`,
      CONVEX_SITE_ORIGIN: `http://localhost:${SITE_HOST_PORT}`,
      RUST_LOG: "error",
    })
    .withStartupTimeout(120_000)
    .start();

  const convexUrl = `http://localhost:${CONVEX_HOST_PORT}`;

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
      { container: 8080, host: RESTATE_INGRESS_PORT },
      { container: 9070, host: RESTATE_ADMIN_PORT }
    )
    .withEnvironment({
      RESTATE_OBSERVABILITY__LOG__FORMAT: "json",
    })
    .withStartupTimeout(60_000)
    .start();

  console.log(
    `[e2e] Restate container started (ingress: ${RESTATE_INGRESS_PORT}, admin: ${RESTATE_ADMIN_PORT})`
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
  const npmResult = spawnSync("npm", ["install"], {
    cwd: CONVEX_DIR,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (npmResult.status !== 0) {
    throw new Error(`npm install failed:\n${npmResult.stderr}`);
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
    { cwd: ROOT, stdio: "pipe", encoding: "utf-8" }
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
      RESTATE_SERVICE_PORT: String(WORKER_SERVICE_PORT),
      RESTATE_INGRESS_URL: `http://localhost:${RESTATE_INGRESS_PORT}`,
      SCAN_REFRESH_SECS: "5",
      RUST_LOG: "debug,crm_worker=debug",
    },
    stdio: ["ignore", workerLogFd, workerLogFd],
  });

  // Give worker time to start its HTTP server
  await new Promise((r) => setTimeout(r, 3000));
  if (worker.exitCode !== null) {
    throw new Error(`crm-worker exited prematurely (code ${worker.exitCode})`);
  }
  console.log(`[e2e] crm-worker running (PID ${worker.pid})`);

  // ── 5c. Register crm-worker with Restate ──────────────────────────
  await registerWorkerWithRestate();

  // ── 6. Set environment for test workers ───────────────────────────
  // VITE_CONVEX_URL is handled by playwright.config.ts webServer.env
  process.env.E2E_CONVEX_URL = convexUrl;
  process.env.E2E_ROBOT_PRIVATE_KEY = privateKeyPem;

  // Store references for teardown
  globalThis.__E2E = { container, restateContainer, worker };
}
