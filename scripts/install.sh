#!/usr/bin/env bash
# PureScience 一键安装脚本 (macOS)
# 用法: bash install.sh <路径或URL到 dmg 文件>
set -e

DMG="${1:-}"
if [ -z "$DMG" ]; then
  echo "用法: bash install.sh <PureScience-xxx.dmg>"
  echo "  - 本地文件: bash install.sh ./zerolink-purescience-0.11.1-mac-arm64.dmg"
  echo "  - 远程 URL: bash install.sh https://github.com/naiyixi/PureScience/releases/download/v0.11.1/zerolink-purescience-0.11.1-mac-arm64.dmg"
  exit 1
fi

echo "=== PureScience 安装器 ==="
if [[ "$DMG" == http* ]]; then
  echo "[1/4] 下载 $DMG ..."
  curl -L --max-time 1800 -o /tmp/purescience-install.dmg "$DMG"
  DMG=/tmp/purescience-install.dmg
else
  [ -f "$DMG" ] || { echo "找不到文件: $DMG"; exit 1; }
fi

echo "[2/4] 挂载安装镜像..."
hdiutil attach "$DMG" -nobrowse
VOL=$(ls /Volumes | grep -i pure | head -1)
[ -n "$VOL" ] || { echo "挂载失败"; exit 1; }
echo "  卷: /Volumes/$VOL"

echo "[3/4] 复制应用到 /Applications ..."
rm -rf /Applications/PureScience.app 2>/dev/null || true
cp -R "/Volumes/$VOL/PureScience.app" /Applications/
hdiutil detach "/Volumes/$VOL" || true

echo "[4/4] 移除隔离属性 (ad-hoc 签名)..."
xattr -dr com.apple.quarantine /Applications/PureScience.app 2>/dev/null || true

echo ""
echo "=== 安装完成 ==="
echo "打开应用: open /Applications/PureScience.app"
echo ""
echo "首次使用:"
echo "  1. 在设置中添加模型提供商 (DeepSeek/Claude/OpenAI 兼容) 并填入 API Key"
echo "  2. 新建研究项目开始使用"
echo ""
echo "服务器模式 (可选): /Applications/PureScience.app/Contents/MacOS/PureScience --headless"
echo "详细文档: docs/DEPLOY.md"
