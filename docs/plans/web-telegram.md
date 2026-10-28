# Browser Telegram login and chats (KAM-42)

`web/src/telegram.ts` is the browser adapter. It keeps one GramJS client per attached account, outside the Foldkit Model. The core remains types only, with no transport dependencies. KAM-43 supplies a native desktop adapter later.

The UI asks for a Telegram application API ID/hash (obtain your own at https://my.telegram.org/apps). Enter a phone number with country code and the code Telegram sends, or choose QR and scan in Telegram → Settings → Devices → Link Desktop Device. Both paths handle a two-step verification password. New Telegram account registration is not supported: create the account in an official app first.

Credentials, pending codes, and MTProto sessions are held only in this tab's memory. Reloading requires login again. The Model and input Messages wrap sensitive input in Effect Redacted; Foldkit runtime devtools and the Vite MCP relay are disabled. The adapter suppresses GramJS logs. Do not enable devtools on accounts containing private data.

`PromisedWebSockets`, `useWSS: true`, and obfuscated MTProto framing explicitly select Telegram's browser endpoint, including on localhost. There is no proxy or application backend. Chromium smoke verification with deliberately invalid application credentials reached `wss://vesta.web.telegram.org/apiws`, received the API credentials error, and reported no browser runtime exceptions. Serve on HTTPS or localhost for Web Crypto.

Phone authentication uses `sendCode` and `auth.SignIn`; 2FA uses Telegram's SRP `computeCheck` and `auth.CheckPassword`. QR exports a token, renders a local QR image, encodes URL-safe tokens with browser-compatible base64 (the browser Buffer polyfill does not support the `base64url` encoding), refreshes through a Foldkit subscription, and handles data-center migration with `_switchDC`/`auth.ImportLoginToken`. Cancelling removes the client and stops the subscription; late results are ignored. Authentication finishes before chat loading, so a chat-list error can be retried without another login.

Each account has its own list and selection. Refresh fetches all dialog pages through GramJS `getDialogs`, including archived dialogs, filtering migrated basic groups in the adapter. Do not enable GramJS 2.26.22’s `ignoreMigrated`: its inverted predicate drops ordinary peers. A regression drives the real GramJS iterator with mocked Telegram responses. Users (including self) map to Dialog; basic groups and megagroups map to Group; broadcasts map to Channel. Unsupported empty peers are omitted rather than stored as groups. Peer IDs are namespaced by Telegram user ID. Missing titles display “Unnamed chat”. Chat opening/history and live updates belong to KAM-44.

Tests cover the Foldkit login flow, QR display, cancellation, multi-account selection, chat refresh errors, isolated clients, SRP invocation, QR migration, and peer classification. Live successful login requires the person's Telegram application credentials and phone/QR/2FA interaction; mocked tests do not establish successful authentication against Telegram.

GramJS 2.26.22 is archived. A task in `.lalph/prd.yml` tracks evaluating its maintained successor and resolving dependency advisories. Do not copy credentials from the legacy project.
