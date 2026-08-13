#!/bin/bash
# PureScience headless 常驻服务 wrapper (zerolink 版)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"
export HOME="/Users/totota"
# 加大 Node/V8 堆内存, 防止密集科学计算任务 OOM 导致会话中断
export NODE_OPTIONS="--max-old-space-size=8192"
cd /Users/totota/purescience
mkdir -p /Users/totota/purescience/logs
exec npm run dev:headless >> /Users/totota/purescience/logs/headless.out.log 2>&1
