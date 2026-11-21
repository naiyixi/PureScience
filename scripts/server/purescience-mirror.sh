#!/bin/bash
# 在服务器上把某个 tag 的 Release 资产拉到站内下载目录，并按发布页的 SHA256SUMS.txt 逐条校验。
# 直连 GitHub 只有 ~20KB/s，优先走加速前缀（按实测速度排序），每条资产下载后仍以 SHA256SUMS 为准。
# 用法：bash /usr/local/bin/purescience-mirror.sh v2.30.2
#
# 2026-11-21 加两件事：
#   1. 把 GitHub 声明的名字+尺寸记进 .sizes.json —— versions.sh 用它抓「文件在但被截断」；
#   2. 全部资产到齐且校验通过才写 .complete —— sync.sh 用它判断「这一版已经镜像完」，
#      而不是看到 SHA256SUMS.txt 就当成完了（那会漏掉一台机器上还没下完的 .deb）。
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
rm -f .complete

release_json=$(mktemp)
trap 'rm -f "$release_json"' EXIT
if ! curl -sS --max-time 60 "https://api.github.com/repos/$REPO/releases/tags/$TAG" -o "$release_json"; then
  echo "!! could not fetch the release metadata for $TAG"; exit 1
fi

assets=$(python3 -c '
import json,sys
try: data=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
for asset in data.get("assets") or []:
    print(asset.get("browser_download_url",""))
' "$release_json")
if [ -z "$assets" ]; then echo "!! no assets resolved for $TAG"; exit 1; fi

# 声明的尺寸一并落盘：versions.json 用它判断文件有没有被截断（存在≠完整）。
python3 -c '
import json,sys
data=json.load(open(sys.argv[1]))
sizes={a["name"]: a["size"] for a in (data.get("assets") or [])}
json.dump(sizes, open(sys.argv[2],"w"), indent=2, sort_keys=True)
' "$release_json" .sizes.json

failures=0
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
  [ "$ok" = 1 ] || { echo "FAIL $name"; failures=$((failures+1)); }
done

echo "--- verify $(date -Is) ---"
if [ -f SHA256SUMS.txt ]; then
  while read -r sum file; do
    [ -f "$file" ] || { echo "MISSING $file"; failures=$((failures+1)); continue; }
    actual=$(sha256sum "$file" | cut -d' ' -f1)
    if [ "$actual" = "$sum" ]; then echo "ok   $file"; else echo "BAD  $file"; failures=$((failures+1)); fi
  done < SHA256SUMS.txt
else
  echo "MISSING SHA256SUMS.txt"; failures=$((failures+1))
fi

# 尺寸复核：SHA256SUMS 只给摘要，截断的文件摘要也对不上 —— 但先把明显的短板挑出来，
# 免得一个小文件的摘要校验被大文件的截断掩盖。
python3 - "$(pwd)" .sizes.json <<'PY'
import json, os, sys
directory, sizes_file = sys.argv[1], sys.argv[2]
try:
    declared = json.load(open(os.path.join(directory, sizes_file)))
except (OSError, ValueError):
    raise SystemExit(0)
bad = []
for name, size in declared.items():
    full = os.path.join(directory, name)
    if os.path.isfile(full) and os.path.getsize(full) != size:
        bad.append(f'{name}: {os.path.getsize(full)} != {size}')
    elif not os.path.isfile(full):
        bad.append(f'{name}: absent')
for entry in bad:
    print(f'SIZE {entry}')
raise SystemExit(1 if bad else 0)
PY
[ $? -ne 0 ] && failures=$((failures+1))

chown -R nginx:nginx "$DEST"
chmod -R u=rwX,go=rX "$DEST"
if [ "$failures" -eq 0 ]; then
  date -Is > .complete
  echo "=== done $TAG $(date -Is) — complete ==="
else
  echo "=== done $TAG $(date -Is) — $failures problem(s), NOT complete ==="
fi
du -sh "$DEST"
exit 0
