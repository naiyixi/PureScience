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
#   5. README bilingual header anchors (badges / intro / banner / DOI) stay byte-identical.
#   6. The shipped local-parsing-model manifest validates and still ships in the package.
#   7. Every Node launcher under scripts/, cli/, packages/purescience/ and build/ parses under Node.
#
# Exit non-zero on any hard failure so the push is refused.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Resolve symlinks: git invokes the hook via .git/hooks/pre-push -> scripts/pre-push-checks.sh,
# so BASH_SOURCE[0] points inside .git/hooks and the naive ROOT above lands in .git. Follow the
# link chain to the real script path before deriving the repo root.
SOURCE_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE_PATH" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  [[ "$SOURCE_PATH" != /* ]] && SOURCE_PATH="$DIR/$SOURCE_PATH"
done
ROOT="$(cd -P "$(dirname "$SOURCE_PATH")/.." && pwd)"
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
# shellcheck source=scripts/brand-patterns.sh
# shellcheck disable=SC1091
source "$ROOT/scripts/brand-patterns.sh"
SENSITIVE_PATTERNS="$BRAND_PATTERNS"
# Scan only tracked files (staged + committed), skipping .web-rooter, dist, the
# pattern-definition script (it legitimately lists the words it scans for), the
# two hook scripts (same reason), and patches/ (patch files are byte-exact
# copies of third-party npm package content — they must match the published
# package tarball verbatim or patch-package fails to apply).
HITS="$(git grep -niE "$SENSITIVE_PATTERNS" -- . ':(exclude).web-rooter' ':(exclude)dist' ':(exclude)patches' ':(exclude)scripts/pre-push-checks.sh' ':(exclude)scripts/commit-msg-checks.sh' ':(exclude)scripts/brand-patterns.sh' 2>/dev/null | grep -v 'Binary file' || true)"
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

# ---------- 5. README bilingual sync anchors (hard fail) ----------
say "README 双语同步核对"
if node scripts/check-readme-sync.mjs >/tmp/readme-sync.log 2>&1; then
  ok "README 头部锚点双语一致"
else
  cat /tmp/readme-sync.log | sed 's/^/      /'
  bad "README 双语头部不一致（徽章/引言/横幅/DOI 需逐字同步）"
  FAIL=1
fi

# ---------- 6. shipped local-parsing-model manifest (hard fail) ----------
# The app reads this manifest offline from the installed package, so a malformed one cannot be fixed by a
# later commit: it is already on every machine that installed the build. `check:model-weights` also asserts
# the file still ships (electron-builder's extraResources mapping), because a manifest nobody installs
# reads to the user as "we never published one".
say "本地解析模型清单核对 (resources/model-weights/manifest.json)"
if node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON scripts/check-model-weight-manifest.mjs >/tmp/model-weight-manifest.log 2>&1; then
  ok "$(tail -1 /tmp/model-weight-manifest.log)"
else
  sed 's/^/      /' /tmp/model-weight-manifest.log
  bad "随包清单未通过核对（清单不合规，或它已不再随包出货）"
  FAIL=1
fi

# ---------- 7. script launchers parse under Node (hard fail) ----------
# scripts/, scripts/ci/, cli/, packages/purescience/ and build/ are outside both tsconfig projects, and
# their .mjs/.cjs files are not parsed by tsc either. A duplicate export in scripts/publish-model-weights.mjs
# therefore made the documented `npm run publish:model-weights` entry die with a SyntaxError while every
# other gate stayed green (vitest still links such a module; eslint never links one). Node's own parser
# is asked here — the same parse that refuses it.
say "脚本入口可解析性核对 (node --check)"
if node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON scripts/check-script-entrypoints.mjs >/tmp/script-entrypoints.log 2>&1; then
  ok "$(tail -1 /tmp/script-entrypoints.log | sed 's/^✓ //')"
else
  sed 's/^/      /' /tmp/script-entrypoints.log
  bad "有脚本入口连 Node 都链接不起来（上面逐个点名）"
  FAIL=1
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
