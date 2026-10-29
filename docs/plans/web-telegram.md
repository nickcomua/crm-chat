# Browser Telegram login and chats (KAM-42, KAM-43)

`web/src/telegram.ts` is the page adapter. In the desktop shell it calls Tauri commands backed by native TDLib, one database directory per account. In the browser it loads the same TDLib version as WebAssembly (`/tdlib/td_wasm.js`) and keeps one client per account. The database is Emscripten's IDBFS, mounted at `/tdlib/<account-id>` and synced to IndexedDB. The core remains types only, with no transport dependencies. See `tdlib.md`.

The UI uses the Telegram application API ID and hash supplied at runtime by SecretSpec (`TG_ID` and `TG_HASH`). See `docs/secrets.md`. If that process was not started with `secretspec run`, the page asks for them instead. Enter a phone number with country code and the code Telegram sends, or choose QR and scan in Telegram → Settings → Devices → Link Desktop Device. Both paths handle a two-step verification password. New Telegram account registration is not supported: create the account in an official app first.

Pending codes stay in this tab. The TDLib database survives a reload through IndexedDB. The Model and input Messages wrap sensitive input in Effect Redacted; Foldkit runtime devtools and the Vite MCP relay are disabled. Do not enable devtools on accounts containing private data.

The browser talks to Telegram through TDLib's wasm client. There is no GramJS package, no Buffer polyfill, and no application backend. Serve on HTTPS or localhost so IndexedDB and Web Crypto are available.

Phone authentication uses `setAuthenticationPhoneNumber` and `checkAuthenticationCode`. Two-step verification uses `checkAuthenticationPassword`. QR uses `requestQrCodeAuthentication`; the page renders the `tg://login` link locally and polls the authorization state. Cancelling logs the client out and closes it. Authentication finishes before chat loading, so a chat-list error can be retried without another login.

Each account has its own list and selection. Refresh loads the main chat list through TDLib `getChats`. Users (including secret chats) map to Dialog; basic groups and megagroups map to Group; channels map to Channel. Unknown chat types are omitted. Peer IDs are namespaced by account id. Missing titles display “Unnamed chat”.

Tests script the TDLib query sink. They cover isolated clients, phone-to-2FA, QR rendering, invalid codes that stay retryable, peer classification, and message order. Live successful login requires application credentials from SecretSpec, or typed for that tab, plus phone/QR/2FA interaction. Mocked tests do not establish successful authentication against Telegram.

Application credentials are not copied into this repo; SecretSpec resolves the legacy BWS key names at runtime.
