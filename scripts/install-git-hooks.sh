#!/usr/bin/env bash
# Installs the PureScience git quality gates as hooks (symlinked so the scripts
# stay version-controlled). Run after cloning or when hooks are missing:
#
#   bash scripts/install-git-hooks.sh
#
# Hooks:
#   pre-push    runs on every `git push`; refuses pushes that fail the
#               sensitive-word scan, the README version banner, or the
#               CHANGELOG entry check.
#   commit-msg  refuses commit messages carrying brand/borrowed-terminology
#               fingerprints (zero-trace rule).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_DIR="$ROOT/.git/hooks"

install_one() {
  local hook_name="$1" source_rel="$2"
  local hook="$HOOK_DIR/$hook_name"
  mkdir -p "$HOOK_DIR"
  if [[ -e "$hook" && ! -L "$hook" ]]; then
    echo "error: $hook already exists as a regular file — remove it first" >&2
    exit 1
  fi
  ln -sf "$source_rel" "$hook"
  echo "installed: $hook -> $source_rel"
}

install_one pre-push    "../../scripts/pre-push-checks.sh"
install_one commit-msg  "../../scripts/commit-msg-checks.sh"
