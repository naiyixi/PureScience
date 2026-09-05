#!/usr/bin/env bash
# PureScience release publisher: build → hash → version.json → GitHub release → verify.
#
# Usage:
#   scripts/publish-release.sh [version] [--dry-run] [--notes-file FILE]
#
#   version      defaults to package.json version (must match it exactly)
#   --dry-run    build + generate manifest only; print the plan, upload nothing
#   --notes-file use FILE as release notes; default = commits since the last tag
#
# Requirements: node, npm, gh (authenticated with workflow scope), ~10 min build.
#
# Pitfalls baked in (do not "simplify"):
#   1. ALWAYS pass -R naiyixi/PureScience to gh: this repo has an `source` remote
#      pointing at a mirror remote; bare `gh release` resolves to the wrong repo silently.
#   2. The client resolves installers by platformDownloadKey() in src/shared/update.ts:
#      darwin/arm64 → "mac-arm64" (NOT "darwin-arm64"). A wrong key makes the client
#      see the update but never find a download.
#   3. The client trusts only downloads whose host === manifest host (github.com).
#      Installer URLs MUST be https://github.com/naiyixi/PureScience/releases/download/<tag>/...
#   4. version.json must be re-uploaded on EVERY release: the client polls the fixed
#      URL .../releases/latest/download/version.json (latest rewrites to newest release).
set -euo pipefail

REPO="naiyixi/PureScience"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------- args ----------
VERSION=""
DRY_RUN=false
NOTES_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --notes-file)
      [[ $# -lt 2 ]] && { echo "error: --notes-file needs a path" >&2; exit 2; }
      NOTES_FILE="$2"; shift 2 ;;
    --*)
      echo "error: unknown option $1" >&2; exit 2 ;;
    *)
      [[ -n "$VERSION" ]] && { echo "error: unexpected argument $1" >&2; exit 2; }
      VERSION="$1"; shift ;;
  esac
done

PKG_VERSION="$(node -p "require('./package.json').version")"
if [[ -z "$VERSION" ]]; then VERSION="$PKG_VERSION"; fi
if [[ "$VERSION" != "$PKG_VERSION" ]]; then
  echo "error: requested version $VERSION != package.json version $PKG_VERSION" >&2
  echo "       bump package.json (and package-lock.json) first, or omit the version arg" >&2
  exit 1
fi
TAG="v$VERSION"

# ---------- build-host platform mapping ----------
# TARGET      → npm script / electron-builder target
# MANIFEST_KEY→ client platformDownloadKey() value
# ARTIFACT_BASE → electron-builder artifactName: zerolink-${name}-${version}-mac-${arch}
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)   TARGET="mac";  ARCH="arm64"; MANIFEST_KEY="mac-arm64";     ARTIFACT_BASE="zerolink-purescience-${VERSION}-mac-arm64" ;;
  Darwin/x86_64)  TARGET="mac";  ARCH="x64";   MANIFEST_KEY="mac-x64";       ARTIFACT_BASE="zerolink-purescience-${VERSION}-mac-x64" ;;
  Linux/x86_64)   TARGET="linux"; ARCH="x64";  MANIFEST_KEY="linux-x64-deb"; ARTIFACT_BASE="zerolink-purescience_${VERSION}_amd64" ;;
  MINGW*|MSYS*|CYGWIN*) TARGET="win"; ARCH="x64"; MANIFEST_KEY="win-x64";    ARTIFACT_BASE="zerolink-purescience-${VERSION}-win-x64" ;;
  *) echo "error: unsupported build host $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

case "$TARGET" in
  mac)   INSTALLER_FILE="${ARTIFACT_BASE}.dmg";  BUILD_CMD="npm run build:mac" ;;
  linux) INSTALLER_FILE="${ARTIFACT_BASE}.deb";  BUILD_CMD="npm run build:linux" ;;
  win)   INSTALLER_FILE="${ARTIFACT_BASE}-setup.exe"; BUILD_CMD="npm run build:win" ;;
esac
INSTALLER_PATH="dist/${INSTALLER_FILE}"

# ---------- tag collision check (before the 10-min build) ----------
if ! $DRY_RUN && gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "error: release $TAG already exists on $REPO (delete it first if you really want to redo it)" >&2
  exit 1
fi

# ---------- build ----------
echo "==> building $TARGET ($VERSION)…"
$BUILD_CMD
if [[ ! -f "$INSTALLER_PATH" ]]; then
  echo "error: expected artifact not found: $INSTALLER_PATH" >&2
  exit 1
fi

# ---------- hashes ----------
SHA256="$(shasum -a 256 "$INSTALLER_PATH" | awk '{print $1}')"
SIZE="$(stat -f%z "$INSTALLER_PATH" 2>/dev/null || stat -c%s "$INSTALLER_PATH")"
echo "==> artifact: $INSTALLER_PATH"
echo "    size:    $SIZE bytes"
echo "    sha256:  $SHA256"

# ---------- release notes ----------
if [[ -n "$NOTES_FILE" ]]; then
  if [[ ! -f "$NOTES_FILE" ]]; then echo "error: notes file not found: $NOTES_FILE" >&2; exit 1; fi
  NOTES="$(cat "$NOTES_FILE")"
else
  PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  if [[ -n "$PREV_TAG" && "$PREV_TAG" != "$TAG" ]]; then
    NOTES="## PureScience $VERSION

$(git log --oneline "${PREV_TAG}..HEAD" | sed 's/^/- /')

> macOS users can install via the in-app updater (Settings → About → Check for updates)."
  else
    NOTES="## PureScience $VERSION

> macOS users can install via the in-app updater (Settings → About → Check for updates)."
  fi
fi

# ---------- version.json ----------
# downloads key MUST match platformDownloadKey() (src/shared/update.ts), see pitfalls.
# Localized notes: when dist/notes-<version>-en.md exists alongside the primary (Chinese) notes,
# version.json carries { zh, en } so the update dialog follows the interface language.
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${INSTALLER_FILE}"
MANIFEST_FILE="dist/version.json"
EN_NOTES_FILE="dist/notes-${VERSION}-en.md"
if [[ -f "$EN_NOTES_FILE" ]]; then
  EN_NOTES="$(cat "$EN_NOTES_FILE")"
else
  EN_NOTES=""
fi
# GitHub release body = primary (Chinese) notes + English summary when the localized file exists.
# The in-app update dialog still reads the { zh, en } manifest pair above; this only makes the
# GitHub release page readable to international visitors.
if [[ -n "$EN_NOTES" ]]; then
  GITHUB_NOTES="$NOTES

---

*English summary*

$EN_NOTES"
else
  GITHUB_NOTES="$NOTES"
fi
node - "$VERSION" "$MANIFEST_KEY" "$DOWNLOAD_URL" "$SIZE" "$SHA256" "$MANIFEST_FILE" "$NOTES" "$EN_NOTES" <<'NODE'
const [version, key, url, size, sha256, out, notes, enNotes] = process.argv.slice(2)
const manifest = {
  version,
  releaseDate: new Date().toISOString(),
  notes: enNotes ? { zh: notes, en: enNotes } : notes,
  downloads: { [key]: { url, size: Number(size), sha256 } }
}
require('fs').writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
console.log(`==> ${out}: version=${version} downloads.${key} (${size} bytes, sha256 ${sha256.slice(0, 16)}…)`)
NODE

if $DRY_RUN; then
  echo "==> DRY RUN — nothing uploaded. Plan:"
  echo "    gh release create $TAG -R $REPO --title \"PureScience $VERSION\""
  echo "    upload: $INSTALLER_PATH, dist/version.json"
  exit 0
fi

# ---------- create release + upload ----------
echo "==> creating release $TAG on ${REPO}…"
gh release create "$TAG" -R "$REPO" --title "PureScience $VERSION" --notes "$GITHUB_NOTES" \
  "$INSTALLER_PATH" "${INSTALLER_PATH}.blockmap" 2>/dev/null \
  || gh release create "$TAG" -R "$REPO" --title "PureScience $VERSION" --notes "$GITHUB_NOTES" \
       "$INSTALLER_PATH"

# version.json must ALWAYS be (re)uploaded: the client polls
# .../releases/latest/download/version.json which rewrites to the newest release's asset.
echo "==> uploading version.json…"
gh release upload "$TAG" -R "$REPO" "$MANIFEST_FILE" --clobber >/dev/null

# ---------- verify ----------
echo "==> verifying…"
LATEST_TAG="$(gh api "repos/${REPO}/releases/latest" --jq '.tag_name')"
if [[ "$LATEST_TAG" != "$TAG" ]]; then
  echo "warning: latest release is $LATEST_TAG, not $TAG (an older release is marked Latest)" >&2
fi
VID="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq "[.assets[] | select(.name==\"version.json\") | .id][0]")"
REMOTE="$(gh api -H "Accept: application/octet-stream" "repos/${REPO}/releases/assets/${VID}")"
REMOTE_KEY="$(node -e "const m=JSON.parse(process.argv[1]);const k=Object.keys(m.downloads)[0];console.log(m.downloads[k].sha256+' '+k)" "$REMOTE")"
REMOTE_SHA="${REMOTE_KEY%% *}"
REMOTE_KEYNAME="${REMOTE_KEY#* }"
if [[ "$REMOTE_SHA" != "$SHA256" ]]; then
  echo "error: uploaded version.json sha256 mismatch (${REMOTE_SHA} vs ${SHA256})" >&2
  exit 1
fi
if [[ "$REMOTE_KEYNAME" != "$MANIFEST_KEY" ]]; then
  echo "error: uploaded version.json key mismatch (${REMOTE_KEYNAME} vs ${MANIFEST_KEY})" >&2
  exit 1
fi
echo "==> done: https://github.com/${REPO}/releases/tag/${TAG}"
echo "    client manifest: https://github.com/${REPO}/releases/latest/download/version.json"
