#!/bin/bash
# 服务器侧的发布同步：查 GitHub 最新 Release,缺哪个版本就拉哪个版本,然后重算 versions.json。
# 由 cron 每 30 分钟跑一次。这样「发了版但官网没更新」不再是人工步骤 —— 也不再依赖谁记得跑脚本。
#
# 2026-11-21 改判据：以前是「目录在 + SHA256SUMS.txt 在」就算镜像完，于是
# v2.32.0 的 .deb 还在下载时，下一次 cron 就以为完事了，再也不会补那个文件。
# 现在只认 mirror 写的 .complete（全部资产到齐 + 摘要与尺寸都过）。
# 另加 flock：cron 每 30 分钟一次，而一次全量镜像要十几分钟，不能两个同时跑。
set -uo pipefail

REPO=naiyixi/PureScience
MIRROR=/usr/local/bin/purescience-mirror.sh
VERSIONS=/usr/local/bin/purescience-versions.sh
LOG=/var/log/purescience-sync.log
LOCK=/var/lock/purescience-sync.lock

exec >>"$LOG" 2>&1

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "=== sync $(date -Is) skipped — another run holds the lock ==="
  exit 0
fi

echo "=== sync $(date -Is) ==="

latest=$(curl -sS --max-time 60 "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(v[^"]*\)"/\1/')
if [ -z "$latest" ]; then
  echo "!! could not resolve the latest release tag"
  exit 1
fi

dir="/var/www/purescience/downloads/$latest"
if [ -f "$dir/.complete" ]; then
  echo "latest=$latest already mirrored"
else
  # 有正在写入的 .part（10 分钟内动过）就不要另起一个镜像：两个 curl 写同一个 .part 会把文件弄坏。
  inflight=$(find "$dir" -maxdepth 1 -name '*.part' -mmin -10 2>/dev/null | head -1)
  if [ -n "$inflight" ]; then
    echo "latest=$latest has a download in flight ($(basename "$inflight")) — skipping this tick"
  else
    echo "latest=$latest not complete — mirroring (present files are skipped)"
    bash "$MIRROR" "$latest" || echo "!! mirror reported a problem for $latest"
  fi
fi

bash "$VERSIONS"
