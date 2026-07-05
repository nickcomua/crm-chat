# crm-chat messaging verification

Date: 2026-07-05
Branch/bookmark: contact-presence-status-ui

## Commands Passed

- `rtk cargo fmt --check`
- `rtk cargo test -p messanger-telegram`
- `rtk cargo test -p crm-worker send_messages`
- `rtk cargo test -p crm-worker outgoing_message_should_send`
- `rtk bun run typecheck` in `bins/crm-chat-web`
- `rtk bun run typecheck` in `bins/convex-backend`
- `rtk bunx biome check tests/helpers.ts tests/fixtures.ts tests/e2e-telegram/messaging-real.spec.ts playwright.config.ts src/components/message-list.tsx` in `bins/crm-chat-web`
- `rtk bunx biome check convex/model/outgoingMessages.ts` in `bins/convex-backend`
- `rtk direnv exec . secretspec run --profile e2e_web -- bunx playwright test tests/e2e-telegram/messaging-real.spec.ts --project=tg-messaging-real --no-deps`
- `rtk nix flake check`

## Notes

- Real Telegram E2E sent a message through the chat composer to Saved Messages and observed the queued outgoing row reach `Sent`.
- The worker replay guard is covered by `outgoing_message_should_send` unit tests.
