# Vendored tdlib-rs

Upstream: https://github.com/FedericoBruzzone/tdlib-rs tag v1.4.0
(`73f220ae28dfd612e1e6ca6f9adfb4b69d411477`). License: MIT OR Apache-2.0.
The license files in this directory are the upstream ones.

`tdlib-rs/tl/api.tl` is TDLib `td/generate/scheme/td_api.tl` from the commit
pinned in `nix/tdlib.nix` (TDLib 1.8.69). `tdlib-rs` generates Rust types from
that file at build time.

Regenerate it from the pinned TDLib source:

    nix run .#regenerate-tdlib-bindings --accept-flake-config

Run that from this repository. It copies `td_api.tl` over `tdlib-rs/tl/api.tl`.
The next native build regenerates the Rust bindings.

Local patch: `tdlib-rs/src/lib.rs` exports `send_json`, and the pkg-config
dependency is `tdjson` 1.8.69 so the crate links the Nix-built library.
