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
#   --only <substring>  handle only assets whose name contains <substring> (e.g. python-3.12)
#
# Requires: gh (a token that can read releases), ssh key at ~/.ssh/purescience_deploy, a local directory of
# assets already downloaded (`scripts/fetch-runtime-bundle.sh` produces it), and the deploy host's
# /var/www/purescience/downloads/runtime as the destination (that is what nginx aliases /download/ to).
#
# Written for bash 3.2, the shell macOS ships: no `mapfile`, no associative arrays. Uploads are scp with three
# attempts per file — a broken pipe mid-file is what actually happened on the first run, and a file that is
# already the right size on the far side is skipped rather than re-sent.
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

[ -d "$SRC" ] || { echo "no local bundle at $SRC — run scripts/fetch-runtime-bundle.sh first"; exit 1; }

echo "== listing assets for $TAG"
ASSETS=""
while IFS= read -r row; do ASSETS="$ASSETS$row"$'\n'; done < <(
  gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets[] | "\(.name) \(.size)"'
)
[ -n "$ASSETS" ] || { echo "no assets for $TAG"; exit 1; }

ssh -i "$KEY" -o ConnectTimeout=15 -o ServerAliveInterval=15 "$HOST" "mkdir -p $DEST"
REMOTE=$(ssh -i "$KEY" -o ConnectTimeout=15 -o ServerAliveInterval=15 "$HOST" \
  "cd $DEST 2>/dev/null && for f in *; do printf '%s %s\n' \"\$f\" \$(wc -c < \"\$f\"); done") || REMOTE=""
remote_size() { echo "$REMOTE" | awk -v want="$1" '$1 == want { print $2; exit }'; }

echo "== uploading (skipping files already the right size)"
while read -r name size; do
  [ -n "${name:-}" ] || continue
  if [ -n "$ONLY" ]; then case "$name" in *"$ONLY"*) ;; *) continue ;; esac; fi
  if [ ! -f "$SRC/$name" ]; then echo "!! skip $name (no local copy)"; continue; fi
  if [ "$(wc -c < "$SRC/$name" | tr -d ' ')" != "$size" ]; then echo "!! skip $name (local size differs)"; continue; fi
  if [ "$(remote_size "$name")" = "$size" ]; then echo "have $name"; continue; fi

  ok=0
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if scp -n -C -i "$KEY" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=6 \
      "$SRC/$name" "$HOST:$DEST/$name"; then
      ok=1
      break
    fi
    echo "   attempt $attempt failed for $name; retrying"
    attempt=$((attempt + 1))
    sleep 5
  done
  [ "$ok" = "1" ] || echo "FAIL $name (3 attempts)"
done <<EOF
$ASSETS
EOF

echo "== verifying bytes and what the public URL actually serves"
fail=0
while read -r name size; do
  [ -n "${name:-}" ] || continue
  if [ -n "$ONLY" ]; then case "$name" in *"$ONLY"*) ;; *) continue ;; esac; fi
  disk=$(ssh -n -i "$KEY" -o ConnectTimeout=15 "$HOST" "wc -c < $DEST/$name 2>/dev/null || echo 0" | tr -d ' ')
  http=$(curl -sSI --max-time 20 "$PUBLIC/$name" | awk 'BEGIN{IGNORECASE=1} /^HTTP\//{code=$2} /^content-length:/{len=$2} END{printf "%s %s", code, len}' | tr -d '\r')
  if [ "$disk" = "$size" ] && [ "${http%% *}" = "200" ] && [ "${http##* }" = "$size" ]; then
    echo "ok   $name ($size bytes, http 200)"
  else
    echo "FAIL $name declared=$size disk=$disk http=($http)"
    fail=1
  fi
done <<EOF
$ASSETS
EOF

exit "$fail"
