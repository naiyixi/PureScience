#!/usr/bin/env bash
# PureScience commit-msg quality gate: refuses commit messages that carry
# third-party brand / borrowed-terminology fingerprints (zero-trace rule).
# Installed as a symlink: .git/hooks/commit-msg -> scripts/commit-msg-checks.sh
#
#   bash scripts/install-git-hooks.sh   (installs pre-push + commit-msg)
set -uo pipefail

MSG_FILE="${1:?usage: commit-msg <message-file>}"
# Resolve symlinks: git invokes the hook via .git/hooks/commit-msg ->
# scripts/commit-msg-checks.sh, so BASH_SOURCE[0] points inside .git/hooks and
# the naive ROOT would land in .git. Follow the link chain to the real path.
SOURCE_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE_PATH" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  [[ "$SOURCE_PATH" != /* ]] && SOURCE_PATH="$DIR/$SOURCE_PATH"
done
ROOT="$(cd -P "$(dirname "$SOURCE_PATH")/.." && pwd)"
# shellcheck source=scripts/brand-patterns.sh
# shellcheck disable=SC1091
source "$ROOT/scripts/brand-patterns.sh"

say() { printf '\033[1;36m[commit-msg]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; }

# Scan the staged commit message subject + body.
HITS="$(grep -niE "$BRAND_PATTERNS" "$MSG_FILE" || true)"
if [[ -n "$HITS" ]]; then
  bad "提交信息含敏感词（品牌零痕迹铁律）:"
  echo "$HITS" | head -8 | sed 's/^/      /'
  bad "请改写提交信息（用中性表述，如 reference product / 参考产品 / vendor），不要绕过。"
  exit 1
fi
ok "提交信息零命中"
exit 0
