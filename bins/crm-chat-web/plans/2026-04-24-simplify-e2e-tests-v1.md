# Simplify E2E Tests — Use Existing `devenv up` Environment

## Objective

Remove the per-worker workspace provisioning (`workspace-new` + `devenv up` orchestration) from Playwright fixtures and the root Nix flake. E2E tests will instead assume the developer already has `devenv up` running and will simply connect to the existing services. Test data for the shared Clerk test account will be cleaned via a Convex mutation both before and after the test suite.

**Assumptions**
- `devenv up` is started manually (or via CI) before invoking Playwright.
- Environment variables (`TEST_BASE_URL`, `VITE_CONVEX_URL`, `CLERK_M2M_SECRET_KEY`, `E2E_SESSION_DIR`, etc.) are injected by `secretspec run --profile e2e_web` (or are already present in `.env`).
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

### Phase 2 — Playwright configuration (`playwright.config.ts`)

- [ ] **Task 2.1.** Remove `globalSetup: "./tests/global-setup.ts"` and `globalTeardown: "./tests/global-teardown.ts"` from `defineConfig`.
  *Rationale:* Global setup is no longer needed for workspace bootstrapping; per-suite cleanup will be handled by `auth.setup.ts` and a new teardown file.

- [ ] **Task 2.2.** Remove the `workspace-smoke` project block (`playwright.config.ts:48-52`).
  *Rationale:* Smoke tests existed only to verify workspace isolation, which is no longer a feature.

- [ ] **Task 2.3.** Remove `workspace-smoke-.*\.spec/` from the `chromium` project `testIgnore` list (it is now unnecessary).
  *Rationale:* There are no more workspace-smoke spec files to ignore.

- [ ] **Task 2.4.** Keep the `setup` project (`auth.setup.ts`) because the browser still needs to authenticate once and produce `tests/.auth/user.json`.
  *Rationale:* Auth state is still required; only the backend provisioning changes.

### Phase 3 — Shared fixtures (`tests/fixtures.ts`)

- [ ] **Task 3.1.** Delete all workspace-orchestration helpers:
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

- [ ] **Task 3.2.** Remove unused imports (`spawn`, `createHash`, `existsSync`, `readFileSync`, `fs`, `os`, `$`).
  *Rationale:* Dead code after removing workspace orchestration.

- [ ] **Task 3.3.** Remove the `PERSIST` constant and all `E2E_PERSIST_WORKSPACE` references.
  *Rationale:* Persistent workspaces are no longer a concept in the test harness.

- [ ] **Task 3.4.** Rewrite the `workerBackend` worker-scoped fixture to a trivial env-var provider:
  ```ts
  workerBackend: [
    async ({}, use) => {
      const convexUrl =
        process.env.VITE_CONVEX_URL ??
        process.env.CONVEX_URL ??
        "http://127.0.0.1:3210";
      const baseURL =
        process.env.TEST_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? "5173"}`;
      await use({
        convexUrl,
        m2mSecretKey: process.env.CLERK_M2M_SECRET_KEY,
        sessionDir: process.env.E2E_SESSION_DIR ?? process.env.TG_SESSION_DIR ?? "",
        baseURL,
      });
    },
    { scope: "worker", timeout: 30_000 },
  ]
  ```
  *Rationale:* Tests still need `convexUrl`, `m2mSecretKey`, and `sessionDir`; they just no longer need them computed from a freshly spawned workspace.

- [ ] **Task 3.5.** Remove the `baseURL` test fixture override (or keep it delegating to `workerBackend.baseURL`). Either approach works because `playwright.config.ts` already defines `use.baseURL`. Removing the override reduces indirection.
  *Rationale:* Simpler fixture surface.

### Phase 4 — Test helpers (`tests/helpers.ts`)

- [ ] **Task 4.1.** Update `WorkerConfig` interface: make `sessionDir` optional and document that it defaults from `E2E_SESSION_DIR`.
  *Rationale:* Most callers already pass `workerCfg` which will continue to contain `sessionDir`; making it optional makes manual construction in teardown easier.

- [ ] **Task 4.2.** Ensure `getSessionPath` still falls back to `process.env.E2E_SESSION_DIR` when `sessionDir` arg is omitted.
  *Rationale:* This already works today; just verify the fallback path remains intact after changes.

- [ ] **Task 4.3.** Export `fetchM2mJwt` (currently private) or export a small `createRobotClient(convexUrl: string): Promise<ConvexHttpClient>` helper that reads `CLERK_M2M_SECRET_KEY` from `process.env` directly.
  *Rationale:* `global-teardown.ts` needs a robot client but cannot use the fixture system.

### Phase 5 — Auth setup & global cleanup (`tests/auth.setup.ts`, `tests/global-setup.ts`, `tests/global-teardown.ts`)

- [ ] **Task 5.1.** In `auth.setup.ts`, after writing `user-meta.json`, instantiate a robot client via `getRobotClient(workerBackend)` and call `cleanupUser(userMeta.tokenIdentifier, robot)`.
  *Rationale:* This satisfies "before e2e tests … clean everything related to testing user". The setup project runs before all dependent projects.

- [ ] **Task 5.2.** Replace `tests/global-setup.ts` with a no-op (or delete it and remove the reference from `playwright.config.ts` which is already covered in Task 2.1).
  *Rationale:* `bun install` inside convex-backend is no longer the test harness’s responsibility; the developer’s `devenv up` handles it.

- [ ] **Task 5.3.** Rewrite `tests/global-teardown.ts` to:
  1. Read `tests/.auth/user-meta.json`.
  2. Skip gracefully if the file is missing.
  3. Create a `ConvexHttpClient` pointing at `process.env.VITE_CONVEX_URL`.
  4. Fetch an M2M JWT (using the exported helper from Task 4.3) and set auth on the client.
  5. Call `cleanupUser(meta.tokenIdentifier, robot)`.
  *Rationale:* This satisfies "remove data in the end".

### Phase 6 — Package scripts & env (`package.json`, `tests/env.ts`)

- [ ] **Task 6.1.** Remove the `test:ui:persist` script from `package.json` (or redefine it without `E2E_PERSIST_WORKSPACE=1`).
  *Rationale:* `E2E_PERSIST_WORKSPACE` is dead.

- [ ] **Task 6.2.** Add `E2E_SESSION_DIR: z.string().optional()` (or `TG_SESSION_DIR`) to `tests/env.ts` so it is validated when present.
  *Rationale:* Tests need to know where to copy Telegram session files; making it explicit in the env schema documents the requirement.

### Phase 7 — Delete obsolete smoke tests

- [ ] **Task 7.1.** Delete `tests/workspace-smoke-a.spec.ts`, `tests/workspace-smoke-b.spec.ts`, and `tests/workspace-smoke-c.spec.ts`.
  *Rationale:* These existed solely to validate the per-worker workspace isolation machinery.

### Phase 8 — Verify remaining specs need no changes

- [ ] **Task 8.1.** Confirm that all remaining `*.spec.ts` files reference `workerBackend` only to obtain `convexUrl` / `m2mSecretKey` / `sessionDir` and do not call workspace-specific helpers.
  *Rationale:* With the simplified fixture, the call sites in `beforeAll` hooks should continue to work unchanged.

- [ ] **Task 8.2.** For `tests/e2e-telegram/*.spec.ts`, verify that `getSessionPath(..., workerCfg.sessionDir)` still receives a valid string from the simplified fixture.
  *Rationale:* The simplified fixture provides `sessionDir` from `E2E_SESSION_DIR`; the helper signatures stay the same.

---

## Verification Criteria

- [ ] `nix fmt` passes for the modified `flake.nix`.
- [ ] `flake.nix` no longer contains `scripts.workspace-new` and no longer lists `rsync` in devShell packages.
- [ ] `bun x playwright test --list` runs without errors (fixture code parses).
- [ ] `auth.setup.ts` successfully authenticates and emits `[e2e] Cleaned test user data before suite` (or similar) in its output.
- [ ] `global-teardown.ts` executes without throwing when `user-meta.json` is missing (idempotent).
- [ ] At least one full e2e spec (e.g., `chat-list.spec.ts`) runs end-to-end against a pre-running `devenv up` and passes.
- [ ] No references to `E2E_PERSIST_WORKSPACE` remain in the codebase.

---

## Potential Risks and Mitigations

1. **Risk: Tests race on shared backend data because they all use the same Clerk user.**
   Mitigation: For now `workers` should be kept at `1` (or tests run with `--workers=1`) until multi-user parallelism is implemented. Document this in a code comment in `playwright.config.ts`.

2. **Risk: `E2E_SESSION_DIR` is not exported by the caller’s environment, causing `getSessionPath` to throw.**
   Mitigation: Update the `e2e_web` secretspec profile (or `.env` template) to export `E2E_SESSION_DIR=target/crm-worker-data` so Telegram e2e specs can copy session files to the same directory the running `crm-worker` process watches.

3. **Risk: `auth.setup.ts` cleanup fails if the Convex backend is temporarily unreachable.**
   Mitigation: Add a small retry loop (e.g., 3 attempts with 2 s backoff) around the `cleanupUser` call in `auth.setup.ts`, or skip the error and let `global-teardown.ts` attempt cleanup again at the end.

4. **Risk: `global-teardown.ts` runs in a separate Node process that does not inherit `secretspec` env vars.**
   Mitigation: Playwright global teardown *does* inherit the runner’s `process.env`, so `CLERK_M2M_SECRET_KEY` and `VITE_CONVEX_URL` are available. Verify this by logging the env keys during a dry run.

---

## Alternative Approaches

1. **Keep `globalSetup` for the "before" cleanup instead of `auth.setup.ts`.**
   Trade-off: `globalSetup` cannot easily determine the Clerk user ID because authentication happens in the browser. We would need an extra API call or hard-code the user ID. Doing cleanup inside `auth.setup.ts` (after browser login) is simpler and guarantees we target the correct user.

2. **Remove `auth.setup.ts` entirely and authenticate per-test.**
   Trade-off: This would make every test slower and increase Clerk API noise. Keeping a single setup project that saves `storageState` is still the right balance.

3. **Move `cleanupUser` into a `test.beforeEach` fixture instead of global setup/teardown.**
   Trade-off: Much slower (Convex mutation before/after every test). Global per-suite cleanup is sufficient because the test suite is serialised by user.
