#!/bin/bash
# One-time grammers login for an integration-test Telegram account.
# Invoked by `nix run .#login-test-account -- <1|2>`.
# Never print session bytes, user ids, phone numbers, API hashes, or vault ids.
set -euo pipefail

if ! command -v secretspec >/dev/null 2>&1; then
  echo "login-test-account: secretspec is not on PATH" >&2
  exit 1
fi
if ! command -v bws >/dev/null 2>&1; then
  echo "login-test-account: bws is not on PATH" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "login-test-account: node is not on PATH" >&2
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
: "${CRM_CHAT_DESKTOP_MANIFEST:?login-test-account: CRM_CHAT_DESKTOP_MANIFEST is unset}"
: "${CRM_CHAT_INVOCATION_DIR:?login-test-account: CRM_CHAT_INVOCATION_DIR is unset}"
: "${CRM_CHAT_SECRET_STATE:?login-test-account: CRM_CHAT_SECRET_STATE is unset}"

usage() {
  echo "usage: nix run .#login-test-account --accept-flake-config -- <1|2>" >&2
  exit 2
}

if [ "$#" -ne 1 ]; then
  usage
fi
slot=$1
case "$slot" in
  1|2) ;;
  *) usage ;;
esac

session_key=TG_SESSION_GRAMMERS_$slot
user_key=TG_USER_NUMERIC_ID_$slot

restore_echo() {
  if [ -r /dev/tty ]; then
    stty echo < /dev/tty >/dev/null 2>&1 || true
  fi
}

redact() {
  sed -E \
    -e 's#bws://[^[:space:]]+#bws://[redacted]#g' \
    -e 's#[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}#[redacted-id]#g'
}

# Prints present or absent. Does not print the secret value.
secret_state() {
  key=$1
  case "$key" in
    *[!A-Z0-9_]*)
      echo "login-test-account: refused an unexpected secret name" >&2
      exit 1
      ;;
  esac
  err=$(mktemp)
  out=$(secretspec run -f "$CRM_CHAT_SECRETS" --provider bws --scope integration -- \
    node "$CRM_CHAT_SECRET_STATE" "$key" 2>"$err") || {
    echo "login-test-account: could not check whether $key already exists" >&2
    if [ -s "$err" ]; then
      redact <"$err" >&2
    fi
    rm -f "$err"
    exit 1
  }
  rm -f "$err"
  case "$out" in
    present|absent) printf '%s' "$out" ;;
    *)
      echo "login-test-account: could not check whether $key already exists" >&2
      exit 1
      ;;
  esac
}

refuse_if_present() {
  key=$1
  state=$(secret_state "$key")
  if [ "$state" = "present" ]; then
    echo "login-test-account: $key already exists; refusing to overwrite, change, or delete it" >&2
    exit 1
  fi
}

refuse_if_present "$session_key"
refuse_if_present "$user_key"

if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
  echo "login-test-account: a terminal is required" >&2
  exit 1
fi

umask 077
work=$(mktemp -d)
cleanup() {
  restore_echo
  rm -rf "$work"
}
trap cleanup EXIT

manifest=$CRM_CHAT_DESKTOP_MANIFEST
if [ -f "$CRM_CHAT_INVOCATION_DIR/integration/desktop/Cargo.toml" ]; then
  manifest=$CRM_CHAT_INVOCATION_DIR/integration/desktop/Cargo.toml
fi
target=${XDG_CACHE_HOME:-$HOME/.cache}/crm-chat/integration-target
mkdir -p "$target"
echo "login-test-account: building grammers login"
cargo build --release --manifest-path "$manifest" --target-dir "$target"
desktop=$target/release/crm-chat-integration-desktop

echo "login-test-account: slot $slot. Phone, code, and 2FA stay in this terminal and are not saved."
err=$(mktemp)
if ! secretspec run -f "$CRM_CHAT_SECRETS" --provider bws --scope app -- \
  "$desktop" login "$work/session" "$work/user-id" 2>"$err"; then
  echo "login-test-account: login failed" >&2
  if [ -s "$err" ]; then
    redact <"$err" >&2
  fi
  rm -f "$err"
  exit 1
fi
if [ -s "$err" ]; then
  redact <"$err" >&2
fi
rm -f "$err"

if [ ! -s "$work/session" ] || [ ! -s "$work/user-id" ]; then
  echo "login-test-account: login did not produce a session and user id" >&2
  exit 1
fi

user_size=$(wc -c <"$work/user-id" | tr -d ' ')
session_size=$(wc -c <"$work/session" | tr -d ' ')
if [ "$user_size" -gt 20 ] || [ "$session_size" -gt 1500000 ] || [ "$session_size" -lt 16 ]; then
  echo "login-test-account: login result was not in the expected shape" >&2
  exit 1
fi
if ! grep -Eq '^[1-9][0-9]*$' "$work/user-id"; then
  echo "login-test-account: getMe did not return a numeric user id" >&2
  exit 1
fi
if ! grep -Eq '^[A-Za-z0-9+/]+=*$' "$work/session"; then
  echo "login-test-account: session was not saved" >&2
  exit 1
fi
if grep -q '[[:space:]]' "$work/user-id" || grep -q '[[:space:]]' "$work/session"; then
  echo "login-test-account: stored material must not contain whitespace" >&2
  exit 1
fi

refuse_if_present "$session_key"
refuse_if_present "$user_key"

store_secret() {
  key=$1
  file=$2
  err=$(mktemp)
  if ! secretspec set "$key" -f "$CRM_CHAT_SECRETS" --provider bws --from-file - <"$file" >"$err" 2>&1; then
    echo "login-test-account: could not store $key. Provider output was withheld." >&2
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"
  state=$(secret_state "$key")
  if [ "$state" != "present" ]; then
    echo "login-test-account: $key was not visible after set; refusing to continue" >&2
    exit 1
  fi
}

store_secret "$user_key" "$work/user-id"
echo "login-test-account: stored $user_key. Storing $session_key." >&2
store_secret "$session_key" "$work/session"

echo "login-test-account: stored $session_key and $user_key. No existing BWS entry was changed."
