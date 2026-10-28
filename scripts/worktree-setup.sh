#!/usr/bin/env bash
# Lalph runs this with cwd set to the new worktree. The script itself stays in
# the launching checkout, which is not the worktree's origin/main.
set -euo pipefail

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
context="$source_root/docs/project-context.md"
pointer='Before changing shells, the Rust core, or Telegram behavior, read `docs/project-context.md`.'

if [[ -f "$context" ]]; then
  mkdir -p docs
  cp "$context" docs/project-context.md
fi

if [[ -f AGENTS.md ]] && ! grep -q 'docs/project-context.md' AGENTS.md; then
  printf '\n%s\n' "$pointer" >> AGENTS.md
fi
