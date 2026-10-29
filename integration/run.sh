#!/bin/sh
# Real SecretSpec + Telegram check. Invoked by `nix run .#integration-test`.
# Prints pass/skip lines and RPC error names only. Never print secret values.
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
: "${CRM_CHAT_WEB_CHECK:?integration-test: CRM_CHAT_WEB_CHECK is unset}"
: "${CRM_CHAT_NODE_MODULES:?integration-test: CRM_CHAT_NODE_MODULES is unset}"
: "${CRM_CHAT_DESKTOP_MANIFEST:?integration-test: CRM_CHAT_DESKTOP_MANIFEST is unset}"
: "${CRM_CHAT_INVOCATION_DIR:?integration-test: CRM_CHAT_INVOCATION_DIR is unset}"

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
      'TG_API_HASH_1',
      'TG_SESSION_FILE_1',
      'TG_USER_ID_1',
      'TG_API_ID_2',
      'TG_API_HASH_2',
      'TG_SESSION_FILE_2',
      'TG_SESSION_GRAMMERS_1',
      'TG_USER_NUMERIC_ID_1',
      'TG_SESSION_GRAMMERS_2',
      'TG_USER_NUMERIC_ID_2',
    ]
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

stage=$(mktemp -d)
cleanup() {
  rm -rf "$stage"
}
trap cleanup EXIT
ln -s "$CRM_CHAT_NODE_MODULES/node_modules" "$stage/node_modules"
cp "$CRM_CHAT_WEB_CHECK" "$stage/web-check.cjs"

manifest=$CRM_CHAT_DESKTOP_MANIFEST
if [ -f "$CRM_CHAT_INVOCATION_DIR/integration/desktop/Cargo.toml" ]; then
  manifest=$CRM_CHAT_INVOCATION_DIR/integration/desktop/Cargo.toml
fi
target=${XDG_CACHE_HOME:-$HOME/.cache}/crm-chat/integration-target
mkdir -p "$target"
echo "integration-test: building grammers TCP check"
cargo build --release --manifest-path "$manifest" --target-dir "$target"
desktop=$target/release/crm-chat-integration-desktop

echo "integration-test: resolving SecretSpec scopes"
scope_env app app
scope_env integration integration

echo "integration-test: web GramJS over WSS"
run_scoped app node --no-warnings "$stage/web-check.cjs"

echo "integration-test: desktop grammers over TCP"
run_scoped app "$desktop" credentials

echo "integration-test: authenticated accounts"
echo "authenticated: web gramjs wss skipped, a grammers sqlite session is not a GramJS string session"
run_scoped integration "$desktop" account
