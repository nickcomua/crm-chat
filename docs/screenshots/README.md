# UI screenshots

Fixture captures of the web shell at 1440×900. No phone numbers, user ids, or session data. The QR image is a decorative grid, not a Telegram login token.

Regenerate with `nix run .#ui-screenshots` from the repo root.

- `login-phone.png` — sign-in when application credentials are supplied
- `login-manual.png` — the same screen when the page must ask for an API ID and hash
- `login-code.png` — the code step
- `login-password.png` — two-step verification
- `login-qr.png` — QR login
- `chat-thread.png` — chat list and an open thread, including unread counts, receipts, and a caption
- `menu.png` — hamburger menu and the More flyout
- `chat-menu.png` — chat header menu and auto-delete choices

`reference-telegram-web-login.png` is the public Telegram Web phone sign-in page (`web.telegram.org/a`), captured without an account. The K client did not paint in headless Chromium. The country prefix on that page is Telegram's own form, not an account number.
