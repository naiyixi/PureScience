#!/usr/bin/env bash
# PureScience 升级演练：v0.17.2 打包版 → 检测 1.0.0 → 应用内升级成功
#
# 用途：验证 1.0.0 版本跳迁（v0.x → v1.0.0）后，旧版打包版能通过
#       更新清单（version.json）正常发现并完成应用内升级。
#
# 前置条件：
#   1. 本机已安装 PureScience v0.17.2 打包版（/Applications/PureScience.app）
#   2. 1.0.0 已发布到 GitHub Releases（version.json 指向 1.0.0）
#
# 用法：
#   scripts/upgrade-rehearsal.sh [--manual] [--app /Applications/PureScience.app]
#
# 默认自动模式会检查所有可脚本化的环节，最后一步（点击应用内更新）
# 需要人工在 UI 中确认，脚本会打印指引。

set -uo pipefail

APP="${APP_PATH:-/Applications/PureScience.app}"
LOG_DIR="$HOME/Library/Logs/PureScience"
DATA_DIR="$HOME/.purescience-project"
MANUAL_ONLY=0
[[ "${1:-}" == "--manual" ]] && MANUAL_ONLY=1

echo "═══ PureScience 1.0.0 升级演练 ═══"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"

fail() { echo "❌ $*"; exit 1; }
pass() { echo "✅ $*"; }

# 1. 旧版存在性
[[ -d "$APP" ]] || fail "未找到打包版 $APP —— 请先安装 v0.17.2"
APP_VERSION=$(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null)
pass "打包版存在，版本 $APP_VERSION"
[[ "$APP_VERSION" == "0.17.2" ]] || echo "⚠️ 当前版本 $APP_VERSION，非 0.17.2（演练目标为 0.17.2 → 1.0.0，继续但留意）"

# 2. 线上更新清单
MANIFEST_URL="https://github.com/naiyixi/PureScience/releases/latest/download/version.json"
MANIFEST=$(curl -sL --max-time 20 "$MANIFEST_URL" 2>/dev/null) || fail "无法获取更新清单"
LATEST=$(printf '%s' "$MANIFEST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))" 2>/dev/null)
[[ -n "$LATEST" ]] || fail "更新清单解析失败"
pass "线上最新版本: $LATEST"

# 3. 版本比较（1.0.0 > 0.17.2）
node -e "
const cmp=(a,b)=>{const p=a.split('.'),q=b.split('.');for(let i=0;i<Math.max(p.length,q.length);i++){const x=+p[i]||0,y=+q[i]||0;if(x>y)return 1;if(x<y)return -1}return 0};
const newer=cmp('$LATEST','$APP_VERSION')>0;
console.log(newer?'NEWER':'NOT_NEWER');
process.exit(newer?0:1);
" >/dev/null 2>&1 || fail "线上 $LATEST 未高于本地 $APP_VERSION —— 1.0.0 尚未发布或清单未更新"
pass "版本跳迁可发现（$APP_VERSION → $LATEST）"

# 4. 清单下载条目完整性（platformDownloadKey: mac-arm64）
node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const m=JSON.parse(s);
  const k=process.argv[1];
  if(!m.downloads||!m.downloads[k]){console.error('missing '+k);process.exit(1)}
  console.log('OK '+m.downloads[k].url);
  process.exit(0);
});
" mac-arm64 <<< "$MANIFEST" || fail "清单缺少 mac-arm64 下载条目"
pass "下载条目完整"

# 5. 数据目录备份提示（升级前建议备份）
if [[ -d "$DATA_DIR" ]]; then
  echo "ℹ️  数据目录 $DATA_DIR 存在 —— 升级前建议："
  echo "      cp -r \"$DATA_DIR\" \"${DATA_DIR}.bak-$(date +%Y%m%d)\""
fi

if [[ "$MANUAL_ONLY" == "1" ]]; then
  echo
  echo "═══ 人工环节指引 ═══"
  echo "1. 打开 PureScience（设置 → 关于 → 检查更新）"
  echo "2. 应看到 1.0.0 更新提示，点击更新并等待安装完成"
  echo "3. 重启后确认：关于页版本号 = 1.0.0，代号 = 浑仪"
  echo "4. 打开一个旧项目会话，确认数据完好"
else
  echo
  echo "ℹ️  自动检查全部通过。请在应用内执行最后一步："
  echo "   设置 → 关于 → 检查更新 → 更新到 $LATEST"
fi
echo "═══ 演练检查完成 ═══"
