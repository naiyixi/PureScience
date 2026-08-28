#!/usr/bin/env bash
# PureScience pre-push quality gate: runs automatically before every `git push`.
#
# Checks:
#   1. Third-party brand / borrowed-terminology scan across git-tracked files
#      (must be ZERO hits — PureScience narrates itself independently).
#   2. README version banner + capability table match package.json version.
#   3. CHANGELOG has an entry for the current package.json version.
#   4. A pending Release for the current version is flagged (publish separately
#      via scripts/publish-release.sh — never blocked here, just reminded).
#
# Exit non-zero on any hard failure so the push is refused.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
FAIL=0
WARN=0

say()  { printf '\033[1;36m[pre-push]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  ⚠\033[0m %s\n' "$*"; }
bad()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*"; }

# ---------- 1. sensitive-word scan (hard fail) ----------
say "敏感词扫描 (brand/borrowed-terminology scan)"
SENSITIVE_PATTERNS='aipoch|open-science|Claude Science|claude-science|CSSwitch|upstream|Upstream|上游|术语统一'
# Scan only tracked files (staged + committed), skipping .web-rooter, dist, and this
# script itself (it legitimately lists the patterns it scans for).
HITS="$(git grep -niE "$SENSITIVE_PATTERNS" -- . ':(exclude).web-rooter' ':(exclude)dist' ':(exclude)scripts/pre-push-checks.sh' 2>/dev/null | grep -v 'Binary file' || true)"
if [[ -n "$HITS" ]]; then
  bad "发现敏感词（${VERSION}）:"
  echo "$HITS" | head -10 | sed 's/^/      /'
  FAIL=1
else
  ok "git 跟踪范围零命中"
fi

# ---------- 2. README version banner (hard fail) ----------
say "README 版本核对"
if [[ ! -f README.md ]]; then
  bad "README.md 不存在"
  FAIL=1
else
  if grep -q "PureScience v${VERSION}" README.md; then
    ok "README 版本横幅 v${VERSION}"
  else
    bad "README 版本横幅不是 v${VERSION}（需更新 README 顶部的发布横幅）"
    FAIL=1
  fi
fi

# ---------- 3. CHANGELOG entry (hard fail) ----------
say "CHANGELOG 补记核对"
if [[ ! -f CHANGELOG.md ]]; then
  bad "CHANGELOG.md 不存在"
  FAIL=1
else
  if grep -q "^## v${VERSION}" CHANGELOG.md; then
    ok "CHANGELOG 已有 v${VERSION} 条目"
  else
    bad "CHANGELOG 缺少 v${VERSION} 条目（推送前需补记）"
    FAIL=1
  fi
fi

# ---------- 4. pending release reminder (soft) ----------
say "发布提醒 (publish-release.sh)"
if command -v gh >/dev/null 2>&1; then
  LATEST="$(gh release view "v${VERSION}" -R naiyixi/PureScience --json tagName --jq .tagName 2>/dev/null || true)"
  if [[ "$LATEST" == "v${VERSION}" ]]; then
    ok "v${VERSION} 已发布到 GitHub Releases"
  else
    warn "v${VERSION} 尚未发布 → 推送后运行: bash scripts/publish-release.sh ${VERSION} --notes-file dist/notes-${VERSION}-zh.md"
    WARN=1
  fi
else
  warn "gh 未安装，跳过发布状态检查"
fi

# ---------- summary ----------
echo
if [[ $FAIL -eq 1 ]]; then
  printf '\033[1;31m[pre-push] 推送被拒绝：存在必须修复的问题。\033[0m\n'
  exit 1
fi
if [[ $WARN -eq 1 ]]; then
  printf '\033[1;33m[pre-push] 检查通过（有提醒项，不阻断）。\033[0m\n'
else
  printf '\033[1;32m[pre-push] 全部通过。\033[0m\n'
fi
exit 0
