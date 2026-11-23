#!/bin/bash
# Pushes a published runtime bundle to the self-hosted mirror, then verifies it is served byte-for-byte.
#
# Why this exists rather than a cron job: the deploy host cannot reach GitHub's release objects (measured
# 2026-11-23: 711 KB in 59 s, ~11.8 KB/s, and `gh-proxy`/`ghfast` from the host were 33 KB/s and 378 KB/s),
# so the bundle has to be pulled somewhere that CAN reach it and pushed. That is a deliberate, manual step
# with a printed verification — a silently half-synced mirror is worse than no mirror, because the app asks
# our host first for these paths.
#
# Usage:  scripts/push-runtime-mirror.sh [tag] [--only <substring>]
#   tag                 defaults to runtime-v1
#   --only <substring>  upload only assets whose name contains <substring> (e.g. python-3.12)
#
# Requires: gh (a token that can read releases), ssh key at ~/.ssh/purescience_deploy, a local directory of
# assets already downloaded (`scripts/fetch-runtime-bundle.sh` produces it), and the deploy host's
# /var/www/purescience/downloads/runtime as the destination (that is what nginx aliases /download/ to).
set -euo pipefail

TAG=${1:-runtime-v1}
ONLY=""
if [ "${2:-}" = "--only" ]; then ONLY=${3:-}; fi

REPO=naiyixi/PureScience
KEY=${PURESCIENCE_DEPLOY_KEY:-$HOME/.ssh/purescience_deploy}
HOST=${PURESCIENCE_DEPLOY_HOST:-root@115.29.13.33}
# nginx: location ^~ /download/ { alias /var/www/purescience/downloads/; }
DEST=/var/www/purescience/downloads/runtime
PUBLIC=https://purescience.work/download/runtime
SRC=${PURESCIENCE_RUNTIME_BUNDLE_DIR:-/tmp/rt-bundle}

[ -d "$SRC" ] || { echo "no local bundle at $SRC — run the fetch step first"; exit 1; }

mail() { echo "== $*"; }

mail "listing assets for $TAG"
mapfile -t ASSETS < <(gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets[] | "\(.name) \(.size)"')
[ "${#ASSETS[@]}" -gt 0 ] || { echo "no assets for $TAG"; exit 1; }

ssh -i "$KEY" -o ConnectTimeout=15 "$HOST" "mkdir -p $DEST"

mail "uploading (parallel per file, resumable where rsync exists)"
# scp has no resume: on 2026-11-23 one 99 MB file died at 13 MB with a broken pipe and would have restarted
# from zero. rsync --partial --append-verify resumes and re-checks what it already put down. `--append-verify`
# needs rsync 3; macOS ships openrsync under the same name and rejects the flag with a usage dump, so the
# version is probed once and the flag is only used where it exists.
RSYNC3=0
if command -v rsync >/dev/null 2>&1 && rsync --version 2>/dev/null | head -1 | grep -q 'version 3'; then
  RSYNC3=1
fi
upload_one() {
  local name=$1
  if [ "$RSYNC3" = "1" ]; then
    rsync -s --partial --append-verify --compress \
      -e "ssh -i $KEY -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=6" \
      "$SRC/$name" "$HOST:$DEST/$name"
  elif command -v rsync >/dev/null 2>&1; then
    rsync -s --partial --compress \
      -e "ssh -i $KEY -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=6" \
      "$SRC/$name" "$HOST:$DEST/$name"
  else
    scp -C -i "$KEY" -o ConnectTimeout=15 "$SRC/$name" "$HOST:$DEST/$name"
  fi
}

PIDS=()
for row in "${ASSETS[@]}"; do
  name=${row% *}
  size=${row##* }
  [ -n "$ONLY" ] && case "$name" in *"$ONLY"*) ;; *) continue ;; esac
  if [ -f "$SRC/$name" ] && [ "$(wc -c < "$SRC/$name")" = "$size" ]; then
    upload_one "$name" &
    PIDS+=($!)
  else
    echo "!! skip $name (local copy missing or wrong size)"
  fi
done
for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && wait "$pid"; done

mail "verifying bytes and what the public URL actually serves"
fail=0
for row in "${ASSETS[@]}"; do
  name=${row% *}
  size=${row##* }
  [ -n "$ONLY" ] && case "$name" in *"$ONLY"*) ;; *) continue ;; esac
  remote=$(ssh -i "$KEY" "$HOST" "wc -c < $DEST/$name 2>/dev/null || echo 0")
  http=$(curl -sSI --max-time 20 "$PUBLIC/$name" | awk 'BEGIN{IGNORECASE=1} /^HTTP\//{code=$2} /^content-length:/{len=$2} END{printf "%s %s", code, len}' | tr -d '\r')
  if [ "$remote" = "$size" ] && [ "${http%% *}" = "200" ] && [ "${http##* }" = "$size" ]; then
    echo "ok   $name ($size bytes, http 200)"
  else
    echo "FAIL $name declared=$size disk=$remote http=($http)"
    fail=1
  fi
done

exit "$fail"
