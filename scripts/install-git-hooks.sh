#!/usr/bin/env bash
# Installs the PureScience pre-push quality gate as a git hook (symlinked so the
# script stays version-controlled). Run after cloning or when hooks are missing:
#
#   bash scripts/install-git-hooks.sh
#
# The hook runs on every `git push` and refuses pushes that fail the
# sensitive-word scan, the README version banner, or the CHANGELOG entry check.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_DIR="$ROOT/.git/hooks"
HOOK="$HOOK_DIR/pre-push"
SOURCE="../../scripts/pre-push-checks.sh"

mkdir -p "$HOOK_DIR"
if [[ -e "$HOOK" && ! -L "$HOOK" ]]; then
  echo "error: $HOOK already exists as a regular file — remove it first" >&2
  exit 1
fi

ln -sf "$SOURCE" "$HOOK"
echo "installed: $HOOK -> $SOURCE"
