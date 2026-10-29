#!/bin/sh
# Real SecretSpec + Telegram check. Invoked by `nix run .#integration-test`.
# Prints pass/skip lines and TDLib error codes only. Never print secret values.
set -eu

if ! command -v secretspec >/dev/null 2>&1; then
  echo "integration-test: secretspec is not on PATH" >&2
  exit 1
fi
if ! command -v bws >/dev/null 2>&1; then
  echo "integration-test: bws is not on PATH" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "integration-test: node is not on PATH" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "integration-test: cargo is not on PATH" >&2
  exit 1
fi

: "${CRM_CHAT_SECRETS:?integration-test: CRM_CHAT_SECRETS is unset}"
: "${CRM_CHAT_INVOCATION_DIR:?integration-test: CRM_CHAT_INVOCATION_DIR is unset}"
: "${CRM_CHAT_TDLIB:?integration-test: CRM_CHAT_TDLIB is unset}"

redact() {
  sed -E \
    -e 's#bws://[^[:space:]]+#bws://[redacted]#g' \
    -e 's#[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}#[redacted-id]#g'
}

run_scoped() {
  scope=$1
  shift
  err=$(mktemp)
  if ! secretspec run -f "$CRM_CHAT_SECRETS" --provider bws --scope "$scope" -- "$@" 2>"$err"; then
    echo "integration-test: secretspec run --provider bws --scope $scope failed" >&2
    redact <"$err" >&2
    rm -f "$err"
    exit 1
  fi
  if [ -s "$err" ]; then
    redact <"$err" >&2
  fi
  rm -f "$err"
}

scope_env() {
  scope=$1
  mode=$2
  run_scoped "$scope" node --input-type=module -e "
    const mode = '${mode}'
    const required = ['TG_ID', 'TG_HASH']
    const integration = [
      'TG_API_ID_1',
      'TG_USER_ID_1',
      'TG_API_ID_2',
      'TG_USER_NUMERIC_ID_1',
      'TG_USER_NUMERIC_ID_2',
    ]
    const unused = [
      'TG_API_HASH_1',
      'TG_API_HASH_2',
      'TG_SESSION_FILE_1',
      'TG_SESSION_FILE_2',
      'TG_SESSION_GRAMMERS_1',
      'TG_SESSION_GRAMMERS_2',
    ]
    const loadedUnused = unused.filter((key) => process.env[key])
    if (loadedUnused.length > 0) {
      console.error(mode + ' scope: loaded unused secrets ' + loadedUnused.join(', '))
      process.exit(1)
    }
    const missing = required.filter((key) => !process.env[key])
    if (missing.length > 0) {
      console.error(mode + ' scope: failed to resolve ' + missing.join(', '))
      process.exit(1)
    }
    const id = process.env.TG_ID
    const hash = process.env.TG_HASH
    if (!/^[1-9]\\d*$/.test(id) || !/^[a-f\\d]{32}$/i.test(hash)) {
      console.error(mode + ' scope: TG_ID or TG_HASH is not in the shape the apps accept')
      process.exit(1)
    }
    if (mode === 'app') {
      const leaked = integration.filter((key) => process.env[key])
      if (leaked.length > 0) {
        console.error('app scope: injected integration keys ' + leaked.join(', '))
        process.exit(1)
      }
    }
    console.log(mode + ' scope: pass')
  "
}

manifest=$CRM_CHAT_INVOCATION_DIR/integration/desktop/Cargo.toml
target=${XDG_CACHE_HOME:-$HOME/.cache}/crm-chat/integration-target
mkdir -p "$target"
export PKG_CONFIG_PATH="$CRM_CHAT_TDLIB/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$CRM_CHAT_TDLIB/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
echo "integration-test: building TDLib check"
cargo build --release --manifest-path "$manifest" --target-dir "$target"
desktop=$target/release/crm-chat-integration-desktop

echo "integration-test: resolving SecretSpec scopes"
scope_env app app
scope_env integration integration

echo "integration-test: desktop TDLib"
run_scoped app "$desktop" credentials

echo "integration-test: saved desktop accounts"
run_scoped app "$desktop" account
