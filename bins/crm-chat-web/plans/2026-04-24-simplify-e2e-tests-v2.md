# Simplify E2E Tests — Use Existing `devenv up` Environment

## Objective

Remove the per-worker workspace provisioning (`workspace-new` + `devenv up` orchestration) from Playwright fixtures and the root Nix flake. E2E tests will instead assume the developer already has `devenv up` running and will simply connect to the existing services. Test data for the shared Clerk test account will be cleaned via a Convex mutation both before and after the test suite.

All environment access in test code **must** go through the `tests/env.ts` schema (`@t3-oss/env-core`). `process.env` must not appear in any test file. `secretspec.toml` is the single source of truth for which variables the `e2e_web` profile provides.

**Assumptions**
- `devenv up` is started manually (or via CI) before invoking Playwright.
- `secretspec run --profile e2e_web` injects every variable declared in `tests/env.ts`.
- For future parallelism the approach will be "add more Clerk test users", not "spawn more isolated workspaces".

---

## Implementation Plan

### Phase 1 — Root Nix flake (`flake.nix`)

- [ ] **Task 1.1.** Remove the `scripts.workspace-new` block entirely (`flake.nix:650-717`).
  *Rationale:* Tests no longer spawn isolated jj workspaces; the script is dead code.

- [ ] **Task 1.2.** Remove `rsync` from the devShell `packages` list (`flake.nix:740`).
  *Rationale:* It was only referenced by `scripts.workspace-new`.

- [ ] **Task 1.3.** Update the `enterShell` comment above `_upsert_env` to remove the specific reference to "parallel workspaces" and `workspace-new`; keep the flock logic because it still protects concurrent shell opens against the same `.env`.
  *Rationale:* The shell upsert logic is still valid for the main workspace, but the comment should not describe a feature we are deleting.

### Phase 2 — Secretspec configuration (`secretspec.toml`)

- [ ] **Task 2.1.** Extend `[profiles.e2e_web]` with the variables the simplified harness now needs:
  - `TEST_BASE_URL` — Playwright `baseURL` pointing at the running Vite dev server.
  - `VITE_CONVEX_URL` — Convex client URL for robot/human clients.
  - `TG_SESSION_DIR` — Directory where Telegram session files are copied so the running `crm-worker` can pick them up. Reuse the same default as `profiles.crm_worker` (`./target/crm-worker-data`).
  - `CONVEX_URL` — Mirror of `VITE_CONVEX_URL` (some helpers may reference it). Mark as optional.
  *Rationale:* Every variable consumed by `tests/env.ts` must be declared in the profile so `secretspec run` documents, validates, and injects it.

### Phase 3 — T3-env schema (`tests/env.ts`)

- [ ] **Task 3.1.** Expand the schema to cover every env var used by test code. No `process.env` may be read outside this file.
  Add to `server`:
  - `TEST_BASE_URL: z.string().url()`
  - `VITE_CONVEX_URL: z.string().url()`
  - `CONVEX_URL: z.string().url().optional()`
  - `TG_SESSION_DIR: z.string().min(1).optional()` — falls back to `./target/crm-worker-data` at call sites if missing.
  Keep existing entries (`TEST_CLERK_USERNAME`, `TEST_CLERK_PASSWORD`, `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_M2M_SECRET_KEY`, `TG_ID`, `TG_HASH`, `TG_SESSION_FILE_1`, `TG_USER_ID_1`).
  *Rationale:* Centralised, typed env validation. Any missing variable fails fast with a clear message instead of an undefined string propagating into a fetch error.

### Phase 4 — Playwright configuration (`playwright.config.ts`)

- [ ] **Task 4.1.** Remove the manual `.env` file parsing loop (`existsSync`, `readFileSync`, dotenv line splitting). Import `env` from `./env` and rely on `secretspec run --profile e2e_web` to populate `process.env` before Playwright starts.
  *Rationale:* `secretspec` already loads the root `.env` via `SECRETSPEC_PROVIDER`. Manual parsing duplicates that work and bypasses the typed schema.

- [ ] **Task 4.2.** Use `env.TEST_BASE_URL` for `use.baseURL`.
  ```ts
  use: {
    baseURL: env.TEST_BASE_URL,
    trace: "on-first-retry",
  },
  ```
  *Rationale:* All env access in test code goes through `env.ts`.

- [ ] **Task 4.3.** Remove `globalSetup` and `globalTeardown` references from `defineConfig`.
  *Rationale:* Global setup is no longer needed for workspace bootstrapping; per-suite cleanup will be handled by `auth.setup.ts` and a rewritten teardown file.

- [ ] **Task 4.4.** Remove the `workspace-smoke` project block.
  *Rationale:* Smoke tests existed only to verify workspace isolation, which is no longer a feature.

- [ ] **Task 4.5.** Remove `workspace-smoke-.*\.spec/` from the `chromium` project `testIgnore` list.
  *Rationale:* There are no more workspace-smoke spec files to ignore.

- [ ] **Task 4.6.** Keep the `setup` project (`auth.setup.ts`) because the browser still needs to authenticate once and produce `tests/.auth/user.json`.
  *Rationale:* Auth state is still required; only the backend provisioning changes.

### Phase 5 — Shared fixtures (`tests/fixtures.ts`)

- [ ] **Task 5.1.** Delete all workspace-orchestration helpers:
  - `composeProjectFor`
  - `parseDotenv`
  - `isWorkspaceHealthy`
  - `cleanupStaleWorkspace`
  - `pollUntilReady`
  - `pollUntilFile`
  - `pollUntilLogContains`
  - `onExit`
  - `serializeBoot`
  - Module-level `bootQueue`
  *Rationale:* These are entirely concerned with creating, health-checking, and destroying per-worker jj workspaces.

- [ ] **Task 5.2.** Remove unused imports (`spawn`, `createHash`, `existsSync`, `readFileSync`, `fs`, `os`, `$`).
  *Rationale:* Dead code after removing workspace orchestration.

- [ ] **Task 5.3.** Remove the `PERSIST` constant and all `E2E_PERSIST_WORKSPACE` references.
  *Rationale:* Persistent workspaces are no longer a concept in the test harness.

- [ ] **Task 5.4.** Rewrite the `workerBackend` worker-scoped fixture to read exclusively from the typed `env` object:
  ```ts
  import { env } from "./env";

  workerBackend: [
    async ({}, use) => {
      await use({
        convexUrl: env.VITE_CONVEX_URL,
        m2mSecretKey: env.CLERK_M2M_SECRET_KEY,
        sessionDir: env.TG_SESSION_DIR ?? "./target/crm-worker-data",
        baseURL: env.TEST_BASE_URL,
      });
    },
    { scope: "worker", timeout: 30_000 },
  ]
  ```
  *Rationale:* Tests still need `convexUrl`, `m2mSecretKey`, and `sessionDir`; they just no longer need them computed from a freshly spawned workspace.

- [ ] **Task 5.5.** Remove the `baseURL` test fixture override so `playwright.config.ts` is the single source of truth for `baseURL`.
  *Rationale:* Simpler fixture surface; avoids indirection.

### Phase 6 — Test helpers (`tests/helpers.ts`)

- [ ] **Task 6.1.** Update `WorkerConfig` interface: make `sessionDir` optional and document that it defaults from `env.TG_SESSION_DIR`.
  *Rationale:* Most callers already pass `workerCfg` which will continue to contain `sessionDir`; making it optional makes manual construction in teardown easier.

- [ ] **Task 6.2.** Update `getSessionPath` to fall back to `env.TG_SESSION_DIR` instead of `process.env.E2E_SESSION_DIR`:
  ```ts
  const baseDir = sessionDir ?? env.TG_SESSION_DIR ?? "./target/crm-worker-data";
  ```
  *Rationale:* Eliminates `process.env` access; uses the typed schema. Remove the old `E2E_SESSION_DIR` reference entirely.

- [ ] **Task 6.3.** Export `fetchM2mJwt` (currently private) or export a `createRobotClient(convexUrl: string): Promise<ConvexHttpClient>` helper that reads `env.CLERK_M2M_SECRET_KEY` directly.
  *Rationale:* `global-teardown.ts` needs a robot client but cannot use the fixture system. It can still import `env` from `./env`.

- [ ] **Task 6.4.** Update `getRobotClient` to use `env.CLERK_M2M_SECRET_KEY` instead of `config.m2mSecretKey` (or keep accepting `config` for flexibility but verify against `env` in the helper).
  *Rationale:* The typed env is the canonical source; passing the key through fixtures is still fine for convenience but the ground truth is `env`.

### Phase 7 — Auth setup & global cleanup (`tests/auth.setup.ts`, `tests/global-setup.ts`, `tests/global-teardown.ts`)

- [ ] **Task 7.1.** In `auth.setup.ts`, after writing `user-meta.json`, instantiate a robot client via `getRobotClient(workerBackend)` and call `cleanupUser(userMeta.tokenIdentifier, robot)`.
  *Rationale:* This satisfies "before e2e tests … clean everything related to testing user". The setup project runs before all dependent projects.

- [ ] **Task 7.2.** Delete `tests/global-setup.ts` (no longer referenced after Phase 4).
  *Rationale:* `bun install` inside convex-backend is no longer the test harness’s responsibility; the developer’s `devenv up` handles it.

- [ ] **Task 7.3.** Rewrite `tests/global-teardown.ts` to:
  1. Import `env` from `./env`.
  2. Read `tests/.auth/user-meta.json`.
  3. Skip gracefully if the file is missing.
  4. Create a `ConvexHttpClient` pointing at `env.VITE_CONVEX_URL`.
  5. Fetch an M2M JWT via the exported helper from Task 6.3 and set auth on the client.
  6. Call `cleanupUser(meta.tokenIdentifier, robot)`.
  *Rationale:* This satisfies "remove data in the end". Even though it is a global file, importing the typed `env` object is valid because `runtimeEnv: process.env` resolves at module load time.

### Phase 8 — Package scripts (`package.json`)

- [ ] **Task 8.1.** Remove the `test:ui:persist` script from `package.json` (or redefine it without `E2E_PERSIST_WORKSPACE=1`).
  *Rationale:* `E2E_PERSIST_WORKSPACE` is dead.

### Phase 9 — Delete obsolete smoke tests

- [ ] **Task 9.1.** Delete `tests/workspace-smoke-a.spec.ts`, `tests/workspace-smoke-b.spec.ts`, and `tests/workspace-smoke-c.spec.ts`.
  *Rationale:* These existed solely to validate the per-worker workspace isolation machinery.

### Phase 10 — Verify remaining specs need no changes

- [ ] **Task 10.1.** Confirm that all remaining `*.spec.ts` files reference `workerBackend` only to obtain `convexUrl` / `m2mSecretKey` / `sessionDir` and do not call workspace-specific helpers.
  *Rationale:* With the simplified fixture, the call sites in `beforeAll` hooks should continue to work unchanged.

- [ ] **Task 10.2.** For `tests/e2e-telegram/*.spec.ts`, verify that `getSessionPath(..., workerCfg.sessionDir)` still receives a valid string from the simplified fixture.
  *Rationale:* The simplified fixture provides `sessionDir` from `env.TG_SESSION_DIR`; the helper signatures stay the same.

---

## Verification Criteria

- [ ] `nix fmt` passes for the modified `flake.nix`.
- [ ] `flake.nix` no longer contains `scripts.workspace-new` and no longer lists `rsync` in devShell packages.
- [ ] `secretspec.toml` contains the three new declarations in `[profiles.e2e_web]` (`TEST_BASE_URL`, `VITE_CONVEX_URL`, `TG_SESSION_DIR`).
- [ ] `bun x playwright test --list` runs without errors (fixture code parses and `env.ts` validates successfully under `secretspec run --profile e2e_web`).
- [ ] `auth.setup.ts` successfully authenticates and emits `[e2e] Cleaned test user data before suite` (or similar) in its output.
- [ ] `global-teardown.ts` executes without throwing when `user-meta.json` is missing (idempotent).
- [ ] At least one full e2e spec (e.g., `chat-list.spec.ts`) runs end-to-end against a pre-running `devenv up` and passes.
- [ ] A project-wide search for `process.env` inside `tests/` returns zero hits (excluding `tests/env.ts` which is allowed to reference `process.env` as `runtimeEnv`).

---

## Potential Risks and Mitigations

1. **Risk: Tests race on shared backend data because they all use the same Clerk user.**
   Mitigation: For now `workers` should be kept at `1` (or tests run with `--workers=1`) until multi-user parallelism is implemented. Document this in a code comment in `playwright.config.ts`.

2. **Risk: `TG_SESSION_DIR` is not exported by the caller’s environment, causing `getSessionPath` to throw.**
   Mitigation: `secretspec.toml` declares it with a default (`./target/crm-worker-data`) so `secretspec run --profile e2e_web` always injects it. The typed schema in `env.ts` also supplies the same fallback.

3. **Risk: `auth.setup.ts` cleanup fails if the Convex backend is temporarily unreachable.**
   Mitigation: Add a small retry loop (e.g., 3 attempts with 2 s backoff) around the `cleanupUser` call in `auth.setup.ts`, or skip the error and let `global-teardown.ts` attempt cleanup again at the end.

4. **Risk: `global-teardown.ts` runs in a separate Node process that does not inherit `secretspec` env vars.**
   Mitigation: Playwright global teardown *does* inherit the runner’s `process.env`, so all values injected by `secretspec run` are available. The typed `env` object will resolve correctly because `runtimeEnv: process.env` is evaluated at import time.

---

## Alternative Approaches

1. **Keep `globalSetup` for the "before" cleanup instead of `auth.setup.ts`.**
   Trade-off: `globalSetup` cannot easily determine the Clerk user ID because authentication happens in the browser. We would need an extra API call or hard-code the user ID. Doing cleanup inside `auth.setup.ts` (after browser login) is simpler and guarantees we target the correct user.

2. **Remove `auth.setup.ts` entirely and authenticate per-test.**
   Trade-off: This would make every test slower and increase Clerk API noise. Keeping a single setup project that saves `storageState` is still the right balance.

3. **Move `cleanupUser` into a `test.beforeEach` fixture instead of global setup/teardown.**
   Trade-off: Much slower (Convex mutation before/after every test). Global per-suite cleanup is sufficient because the test suite is serialised by user.
