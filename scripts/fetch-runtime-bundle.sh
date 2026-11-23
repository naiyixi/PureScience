#!/bin/bash
# Pulls a runtime bundle's release assets into a local directory, so `push-runtime-mirror.sh` can push them
# to the self-hosted mirror. Needed because the deploy host itself cannot reach GitHub's release objects.
#
# Usage:  scripts/fetch-runtime-bundle.sh [tag] [dir]
#   tag   defaults to runtime-v1
#   dir   defaults to /tmp/rt-bundle
#
# A partial download is kept and resumed (`curl -C -`) so a dropped connection does not restart a ~100 MB
# file; the size of every file is compared against the release's declared size before it is considered done.
set -euo pipefail

TAG=${1:-runtime-v1}
OUT=${2:-/tmp/rt-bundle}
REPO=naiyixi/PureScience
BASE="https://github.com/$REPO/releases/download/$TAG"
PROXY=${PURESCIENCE_HTTPS_PROXY:-}

mkdir -p "$OUT"
cd "$OUT"

mapfile -t ASSETS < <(gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets[] | "\(.name) \(.size)"')
[ "${#ASSETS[@]}" -gt 0 ] || { echo "no assets for $TAG"; exit 1; }

for row in "${ASSETS[@]}"; do
  name=${row% *}
  size=${row##* }
  if [ -f "$name" ] && [ "$(wc -c < "$name")" = "$size" ]; then
    echo "have $name ($size)"
    continue
  fi
  echo "get  $name ($size)"
  if [ -n "$PROXY" ]; then
    curl -sSL --proxy "$PROXY" --retry 3 --retry-delay 5 -C - -o "$name" "$BASE/$name"
  else
    curl -sSL --retry 3 --retry-delay 5 -C - -o "$name" "$BASE/$name"
  fi
done

echo "== verifying declared sizes"
fail=0
for row in "${ASSETS[@]}"; do
  name=${row% *}
  size=${row##* }
  got=$(wc -c < "$name" 2>/dev/null || echo 0)
  if [ "$got" = "$size" ]; then echo "ok   $name"; else echo "FAIL $name got=$got declared=$size"; fail=1; fi
done
exit "$fail"
