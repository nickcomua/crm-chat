# TDLib

Telegram goes through TDLib 1.8.69, pinned in `nix/tdlib.nix`. The latest git
tag is v1.8.0 from 2021-12-29. That client cannot talk to current Telegram.
The flake pins the commit whose CMake version is 1.8.69
(`4c6377aa7386c39217878a9a56d581922ad37ca4`).

`third_party/tdlib-rs` is FedericoBruzzone/tdlib-rs v1.4.0, with `tl/api.tl`
replaced by that commit's `td_api.tl`. The crate generates Rust bindings from
that file when it builds. Regenerate the scheme from the pinned source:

    nix run .#regenerate-tdlib-bindings --accept-flake-config

Run that from this repository. The next native build regenerates the Rust.

Native TDLib is `nix build .#tdlib`. The desktop shell links it and keeps one
database directory per account at:

    $XDG_DATA_HOME/app.crmchat.desktop/tdlib/<account-id>

`$XDG_DATA_HOME` defaults to `$HOME/.local/share`. The database encryption key
is empty, so the files are protected by the OS user account, not by a key in
this repo. `CRM_CHAT_TDLIB_DIR` overrides the directory for tests.

`nix run .#integration-test` copies that directory, then opens the copy with
TDLib and the SecretSpec application credentials (`TG_ID`, `TG_HASH`). It does
not read BWS session entries and it does not write to the saved directory. A
restored account must match the desktop `Authorized` shape: `_tag` is
`Authorized`, and `account` holds the id, title, and chats. If the directory
has no logged-in account, it prints `NEEDS TEST ACCOUNTS:` and exits 2.
`nix flake check` runs only the offline `shape` command. Log in once in the
desktop shell, or with
`nix run .#login-test-account --accept-flake-config -- <1|2>`. That command
writes account `1` or `2` into the same directory. It does not create, delete,
or change BWS entries.

The browser uses the same TDLib version, built with emscripten 3.1.1. The
pin is `nix/emscripten.nix`: emsdk's linux release
`5ee64de9809592480da01372880ea11debd6c740`. `nix build .#tdlibWasm` runs
TDLib's `example/web` scripts: OpenSSL 1.1.0l, then `td_wasm`. The page loads
`/tdlib/td_wasm.js` and persists each account under IndexedDB by mounting
Emscripten's IDBFS at `/tdlib/<account-id>`, the same filesystem mount tdweb
uses. There is no GramJS package and no grammers fallback.

`nix flake check` builds that package on x86_64-linux and checks the wasm
magic, `createTdwebModule`, the IDBFS link, and emscripten 3.1.1.
