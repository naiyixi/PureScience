#!/usr/bin/env bash
# Replay the hardcoded-copy audit against a KNOWN-BAD revision: copy the given paths as they were at
# <rev> into a temp dir, then run the audit on that dir. An instrument whose miss cannot be
# demonstrated has no evidence that it would have caught anything — and the broken revision is not in
# the tree, so the audit's explicit-path form needs this materialiser to be usable at all.
#
# Usage: scripts/i18n-audit-replay.sh <rev> <path…>
#   e.g. scripts/i18n-audit-replay.sh 809adb33 src/renderer/src/pages/settings/SpecialistsPanel.tsx
#        scripts/i18n-audit-replay.sh 809adb33 src/renderer/src/pages/settings src/renderer/src/pages/workspace
# Pass DIRECTORIES to replay a whole subtree (expanded to the revision's file list).
set -euo pipefail

rev="${1:?用法: $0 <rev> <path…>}"
shift
[ "$#" -gt 0 ] || { echo "至少给一个路径" >&2; exit 2; }

dir="$(mktemp -d "${TMPDIR:-/tmp}/ps-i18n-replay.XXXXXX")"
trap 'rm -rf "$dir"' EXIT

files=()
for p in "$@"; do
  if git cat-file -e "$rev:$p" 2>/dev/null && [ "$(git cat-file -t "$rev:$p")" = "tree" ]; then
    while IFS= read -r f; do files+=("$f"); done < <(git ls-tree -r --name-only "$rev" "$p")
  else
    files+=("$p")
  fi
done

for p in "${files[@]}"; do
  mkdir -p "$dir/$(dirname "$p")"
  git show "$rev:$p" > "$dir/$p"
done

echo "重放版本 $(git rev-parse --short "$rev") / ${#files[@]} 个文件 → $dir"
node scripts/i18n-hardcoded-audit.mjs "$dir"
