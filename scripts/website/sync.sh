#!/bin/bash
# 服务器侧的发布同步：查 GitHub 最新 Release,缺哪个版本就拉哪个版本,然后重算 versions.json。
# 由 cron 每 30 分钟跑一次。这样「发了版但官网没更新」不再是人工步骤 —— 也不再依赖谁记得跑脚本。
set -uo pipefail

REPO=naiyixi/PureScience
MIRROR=/usr/local/bin/purescience-mirror.sh
VERSIONS=/usr/local/bin/purescience-versions.sh
LOG=/var/log/purescience-sync.log

exec >>"$LOG" 2>&1
echo "=== sync $(date -Is) ==="

latest=$(curl -sS --max-time 60 "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(v[^"]*\)"/\1/')
if [ -z "$latest" ]; then
  echo "!! could not resolve the latest release tag"
  exit 1
fi

if [ -d "/var/www/purescience/downloads/$latest" ] \
   && [ -f "/var/www/purescience/downloads/$latest/SHA256SUMS.txt" ]; then
  echo "latest=$latest already mirrored"
else
  echo "latest=$latest missing — mirroring"
  bash "$MIRROR" "$latest"
fi

bash "$VERSIONS"
