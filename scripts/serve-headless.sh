#!/bin/bash
# PureScience headless 常驻服务 wrapper (zerolink 版)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"
export HOME="/Users/totota"
cd /Users/totota/purescience
mkdir -p /Users/totota/purescience/logs
exec npm run dev:headless >> /Users/totota/purescience/logs/headless.out.log 2>&1
