#!/bin/bash
# One-time TDLib login for an integration-test Telegram account.
# Invoked by `nix run .#login-test-account -- <1|2>`.
# Writes the account database under the desktop shell data directory.
# Never print session bytes, user ids, phone numbers, API hashes, or vault ids.
# Does not create, delete, overwrite, or change BWS entries.
set -euo pipefail

if ! command -v secretspec >/dev/null 2>&1; then
  echo "login-test-account: secretspec is not on PATH" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "login-test-account: cargo is not on PATH" >&2
  exit 1
fi
if ! command -v stty >/dev/null 2>&1; then
  echo "login-test-account: stty is not on PATH" >&2
  exit 1
fi

: "${CRM_CHAT_SECRETS:?login-test-account: CRM_CHAT_SECRETS is unset}"
: "${CRM_CHAT_INVOCATION_DIR:?login-test-account: CRM_CHAT_INVOCATION_DIR is unset}"
: "${CRM_CHAT_TDLIB:?login-test-account: CRM_CHAT_TDLIB is unset}"

usage() {
  echo "usage: nix run .#login-test-account --accept-flake-config -- <1|2>" >&2
  exit 2
}

if [ "$#" -ne 1 ]; then
  usage
fi
case "$1" in
  1|2) ;;
  *) usage ;;
esac

manifest=$CRM_CHAT_INVOCATION_DIR/integration/desktop/Cargo.toml
target=${XDG_CACHE_HOME:-$HOME/.cache}/crm-chat/integration-target
mkdir -p "$target"
export PKG_CONFIG_PATH="$CRM_CHAT_TDLIB/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$CRM_CHAT_TDLIB/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
echo "login-test-account: building TDLib login"
cargo build --release --manifest-path "$manifest" --target-dir "$target"
desktop=$target/release/crm-chat-integration-desktop

exec secretspec run -f "$CRM_CHAT_SECRETS" --provider bws --scope app -- "$desktop" login "$1"
