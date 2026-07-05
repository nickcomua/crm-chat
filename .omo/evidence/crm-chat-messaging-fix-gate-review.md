# Gate Review: crm-chat messaging fix

recommendation: REJECT

originalIntent:
- The user reported that messaging was broken and wanted a Playwright integration test that sends Telegram messages.
- Prior constraints: real Telegram E2E for Telegram-facing milestones, Playwright for UI, nix flake check must pass, minimal flake changes, use jj commit, and include .omo if changed.

desiredOutcome:
- A user can send a Telegram message from the chat composer through the real UI and worker path.
- The message is actually sent through Telegram, recorded as Sent, visible in the chat UI, and covered by a real Telegram Playwright E2E.
- Evidence artifacts prove the E2E, nix flake check, focused typecheck/lint/tests, manual QA, code review, and slop/overfit review.

userOutcomeReview:
- The diff adds a real Telegram Playwright test at `bins/crm-chat-web/tests/e2e-telegram/messaging-real.spec.ts` that drives the composer and checks the outgoing row, UI text, and messages table.
- The production diff attempts to fix sending by keeping `Sending` rows in `outgoingMessages.pendingWork`, marking worker send failures as Failed, using a direct Telegram client, resolving `+...` targets via `get_me().to_ref()`, and clearing the composer only on `{ Ok: ... }`.
- I cannot approve the user-visible outcome because the required evidence package is missing, the jj commit constraint is not satisfied, and the send queue remains non-idempotent around `Sending` rows.

blockers:
1. Missing required gate artifacts.
   - No current code review report, manual QA matrix, notepad path, real Telegram Playwright log, nix flake check log, typecheck/biome log, or cargo test log was present under `.omo`.
   - Checked `.omo/evidence`, `.omo/evidence/contact-information`, `.omo/evidence/contact-presence`, `.omo/evidence/t2-message-entities`, and `.omo/lazycodex-executor-verify`.
   - Existing `.omo/evidence` content is unrelated contact/message-entity evidence. The executor verification claims in the prompt are prose only and are unsupported by artifact paths.

2. Required slop/programming report coverage is absent, and direct slop pass found unresolved maintenance blockers.
   - No code review report exists showing the required skill-perspective review or remove-ai-slops overfit/slop criterion coverage.
   - Direct programming pass measured touched files above the 250 pure LOC ceiling with added code and no split or `SIZE_OK` justification:
     - `bins/crm-chat-web/src/components/message-list.tsx`: 558 pure LOC.
     - `bins/crm-chat-web/tests/helpers.ts`: 399 pure LOC.
     - `bins/crm-worker/src/session_manager.rs`: 291 pure LOC.
     - `libs/messanger-telegram/src/messenger.rs`: 1085 pure LOC.
   - The new E2E is not deletion-only or tautological, but it only proves the happy path and does not cover duplicate-send/idempotency behavior introduced by the queue change.

3. `jj commit` constraint is not satisfied.
   - `jj status` shows the changed files in the working copy commit `@` with `(no description set)`.
   - Parent is `rwzkskmw 0006c459 contact-presence-status-ui | Add contact information visual evidence`.
   - This is not a completed `jj commit` with an intentional description.

4. High-risk functional blocker: the send job is not idempotent while `Sending` rows remain in the runner set.
   - `bins/convex-backend/convex/model/outgoingMessages.ts:91` now returns both `Queued` and `Sending` rows from `pendingWork`.
   - `bins/crm-worker/src/runner.rs` removes a finished handle when the key is still in the wanted set, then respawns the key in the same tick.
   - `bins/crm-worker/src/jobs/send_messages.rs:56` does not check the outgoing row status before sending, and `bins/crm-worker/src/jobs/send_messages.rs:114` performs the external Telegram send unconditionally.
   - Because Telegram send is a non-idempotent side effect, a `Sending` subscription snapshot processed after the first task finishes can cause a duplicate send. A worker restart after Telegram accepted the message but before `workerMarkSent` also resends. The new Playwright test only checks that at least one row reaches Sent, not exactly-once behavior or absence of duplicate messages.

checked artifact paths:
- `.omo/evidence`
- `.omo/evidence/contact-information`
- `.omo/evidence/contact-presence`
- `.omo/evidence/t2-message-entities`
- `.omo/lazycodex-executor-verify`
- `bins/convex-backend/convex/model/outgoingMessages.ts`
- `bins/crm-chat-web/playwright.config.ts`
- `bins/crm-chat-web/src/components/message-list.tsx`
- `bins/crm-chat-web/tests/fixtures.ts`
- `bins/crm-chat-web/tests/helpers.ts`
- `bins/crm-chat-web/tests/e2e-telegram/messaging-real.spec.ts`
- `bins/crm-worker/src/jobs/send_messages.rs`
- `bins/crm-worker/src/session_manager.rs`
- `bins/crm-worker/src/runner.rs`
- `flake.nix`
- `libs/messanger-telegram/src/lib.rs`
- `libs/messanger-telegram/src/messenger.rs`
- `secretspec.toml`
- `bins/crm-chat-web/tests/env.ts`

exact evidence gaps:
- No artifact proves the reported real Telegram Playwright send test passed.
- No artifact proves `nix flake check` passed on aarch64-darwin.
- No artifact proves focused typecheck, Biome, or cargo tests passed.
- No manual QA matrix was provided or found.
- No notepad path was provided or found.
- No code review report was provided or found.
- No report demonstrates remove-ai-slops overfit/slop coverage or programming criteria coverage.
- No test or artifact proves the `Sending` queue change preserves exactly-once sending or avoids duplicate Telegram sends.
