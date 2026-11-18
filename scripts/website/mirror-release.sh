#!/bin/bash
# 在服务器上把某个 tag 的 Release 资产拉到站内下载目录，并按发布页的 SHA256SUMS.txt 逐条校验。
# 直连 GitHub 只有 ~20KB/s，优先走加速前缀（按实测速度排序），每条资产下载后仍以 SHA256SUMS 为准。
# 用法：bash /tmp/mirror-release.sh v2.30.2
set -uo pipefail
TAG="${1:?tag required}"
REPO=naiyixi/PureScience
DEST="/var/www/purescience/downloads/$TAG"
LOG="/var/log/purescience-mirror-$TAG.log"
PREFIXES=("https://ghfast.top/" "https://ghproxy.net/" "")

exec >>"$LOG" 2>&1
echo "=== start $TAG $(date -Is) ==="

mkdir -p "$DEST"
cd "$DEST" || exit 1

assets=$(curl -sS --max-time 60 "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
  | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/')
if [ -z "$assets" ]; then echo "!! no assets resolved for $TAG"; exit 1; fi

for url in $assets; do
  name=$(basename "$url")
  if [ -s "$name" ]; then echo "skip $name (present)"; continue; fi
  ok=0
  for prefix in "${PREFIXES[@]}"; do
    for attempt in 1 2; do
      echo "get  $name via ${prefix:-direct} (try $attempt)"
      if curl -fL --retry 1 --retry-delay 5 --speed-limit 20000 --speed-time 30 \
              --max-time 3600 -o "$name.part" "${prefix}${url}"; then
        mv "$name.part" "$name"; ok=1; break 2
      fi
      rm -f "$name.part"
      sleep 5
    done
  done
  [ "$ok" = 1 ] || echo "FAIL $name"
done

if [ -f SHA256SUMS.txt ]; then
  echo "--- verify $(date -Is) ---"
  while read -r sum file; do
    [ -f "$file" ] || { echo "MISSING $file"; continue; }
    actual=$(sha256sum "$file" | cut -d' ' -f1)
    if [ "$actual" = "$sum" ]; then echo "ok   $file"; else echo "BAD  $file"; fi
  done < SHA256SUMS.txt
fi

chown -R nginx:nginx "$DEST"
chmod -R u=rwX,go=rX "$DEST"
echo "=== done $TAG $(date -Is) ==="
du -sh "$DEST"
