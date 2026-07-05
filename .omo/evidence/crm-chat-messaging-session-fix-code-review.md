# crm-chat messaging/session fix code review

## Decision

- codeQualityStatus: CLEAR
- recommendation: APPROVE
- reportPath: `.omo/evidence/crm-chat-messaging-session-fix-code-review.md`
- blockers: None

## Scope

Focused re-review of the previous blockers only:

- `bins/crm-worker/src/jobs/send_messages.rs`
- `bins/convex-backend/convex/model/outgoingMessages.ts`
- `.omo/evidence/crm-chat-messaging-verification.md`
- current diff where needed for scheduling/evidence context

## Skill-Perspective Check

- `omo:remove-ai-slops`: loaded and applied as a review lens for overfit/slop in scoped production code and tests. No deletion-only tests, requested-removal-only tests, tautological tests, implementation-only prompt tests, or unnecessary production parsing/extraction were found in the scoped remediation.
- `omo:programming`: loaded with Rust and TypeScript reference entry points. The scoped remediation does not introduce untyped escape hatches, broad catch/suppression patterns, needless abstractions, or boundary parsing drift. The status helper test is narrow but acceptable because it locks the active-vs-terminal policy used before Telegram send.

## Verification Performed

- Inspected current status and diff for the scoped files.
- Inspected `bins/crm-worker/src/jobs/send_messages.rs`.
- Inspected `bins/convex-backend/convex/model/outgoingMessages.ts`.
- Inspected `.omo/evidence/crm-chat-messaging-verification.md`.
- Inspected worker runner behavior enough to confirm one in-process task per key.
- Ran `rtk cargo test -p crm-worker send_messages`: PASS, 4 tests.
- Ran `rtk bunx biome check convex/model/outgoingMessages.ts` in `bins/convex-backend`: PASS.
- Ran `rtk bun run typecheck` in `bins/convex-backend`: PASS.

I did not rerun the real Telegram E2E or `nix flake check`; the artifact path exists and records those claimed runs.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

None.

## Previous Blocker Resolution

1. SendMessagesJob terminal-row idempotency: RESOLVED.
   `run_one` now checks `outgoing_message_should_send(outgoing.status)` before building the Telegram send path and returns `Ok(())` for `Sent` and `Failed` rows. The Telegram call is after this guard, so stale/replayed terminal rows no-op before send. References: `bins/crm-worker/src/jobs/send_messages.rs:65`, `bins/crm-worker/src/jobs/send_messages.rs:126`, `bins/crm-worker/src/jobs/send_messages.rs:214`.

2. `workerMarkSending` guarded transition: RESOLVED.
   The Convex mutation returns `err("Message is terminal")` before patching if the row is `Sent` or `Failed`. A race where another worker terminalized the row after `getForWorker` but before `workerMarkSending` now stops before Telegram because `.check()?` propagates that error. References: `bins/convex-backend/convex/model/outgoingMessages.ts:122`, `bins/convex-backend/convex/model/outgoingMessages.ts:136`, `bins/convex-backend/convex/model/outgoingMessages.ts:139`, `bins/crm-worker/src/jobs/send_messages.rs:120`.

3. Reviewable evidence artifact: RESOLVED.
   `.omo/evidence/crm-chat-messaging-verification.md` exists and lists the claimed verification commands plus the real Telegram E2E note. The artifact is locally ignored under `.omo/`, which appears consistent with evidence artifact handling in this workspace rather than a scoped blocker.

## Residual Risk

The review was intentionally scoped to the prior blockers. I did not perform a full branch review of unrelated changed files.
