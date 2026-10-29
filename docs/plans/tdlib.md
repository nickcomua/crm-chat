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

`nix run .#integration-test` opens that directory with TDLib and the
SecretSpec application credentials (`TG_ID`, `TG_HASH`). It does not read BWS
session entries. If the directory has no logged-in account, it prints
`NEEDS TEST ACCOUNTS:` and exits 2. Log in once in the desktop shell, or with
`nix run .#login-test-account --accept-flake-config -- <1|2>`. That command
writes account `1` or `2` into the same directory. It does not create, delete,
or change BWS entries.

A pure tdlib-rs wasm32-unknown-unknown build is not possible: tdlib-rs links
libtdjson. The desktop page calls the native crate through Tauri. The browser
page still uses GramJS until the emscripten package exists.

BLOCKED: tdlib wasm. TDLib's `example/web/build-tdlib.sh` requires emscripten
3.1.1 exactly. The pinned nixpkgs emscripten is 6.0.9, and that script exits
before configure when the version does not match. Smallest options: pin emsdk
3.1.1 in the flake and follow `example/web` (OpenSSL 1.1.0l, then `td_wasm`);
or patch that build for emscripten 6 and cache it; or build `td_wasm` once
with emsdk 3.1.1 and vendor the artifacts. Do not fall back to GramJS or
grammers for the browser path.
