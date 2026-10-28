#!/bin/bash
# 四框架「框架 == 二进制」真机探针（C1）。
#
# 为什么需要它：CI 只跑映射守卫（src/main/settings/agent-runtime-manager.test.ts 的 C1 两例），
# 因为 GitHub runner 上没有这四个 CLI。真机的 executablePath 只能在本机断言 —— 而这个缺陷的形态
# 恰恰是「名字对、跑的是别人」（历史事故：框架 id 说 codebuddy，实际跑的是 opencode）。
#
# 用法：bash scripts/probe-framework-binaries.sh [端口]
# 输出：每个框架一行 stored / resolved / path，四行路径必须互不相同。
set -u
PORT="${1:-44670}"
ROOT="${PURESCIENCE_CONFIG_ROOT:-$HOME/.purescience}"
ROOT="${ROOT/#\~/$HOME}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UD="$ROOT/electron-userdata-probe-$PORT"
TOKEN=$(tr -d '\n' < "$ROOT/web-token")

# 独立 user-data-dir：主实例通常已在运行，共用目录会因单实例锁直接退出。
PURESCIENCE_CONFIG_ROOT="$ROOT" PURESCIENCE_STORAGE_ROOT="$ROOT" PURESCIENCE_WEB_PORT="$PORT" \
  "$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$REPO" \
  --purescience-headless --disable-gpu --user-data-dir="$UD" > "/tmp/ps-probe-$PORT.log" 2>&1 &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null; sleep 1; kill -9 "$PID" 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$PORT/api/v1/readiness?token=$TOKEN")
  [ "$CODE" = "200" ] && break
  sleep 2
done
if [ "$CODE" != "200" ]; then
  echo "headless 未就绪（readiness=$CODE），日志：/tmp/ps-probe-$PORT.log" >&2
  exit 1
fi

rpc() {
  curl -s --max-time 180 -X POST -H 'content-type: application/json' \
    -d "{\"protocolVersion\":1,\"args\":$2}" \
    "http://127.0.0.1:$PORT/rpc/$1?token=$TOKEN"
}

PATHS=""
for FW in claude-code opencode codex codebuddy; do
  STORED=$(rpc "settings:set-agent-framework" "[{\"id\":\"$FW\"}]" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d['result'].get('agentFrameworkId') if d.get('ok') else 'ERR')" 2>/dev/null)
  LINE=$(rpc "settings:check-environment" "[]" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('ok'):
    print('$FW stored=$STORED ERROR ' + json.dumps(d)[:120]); raise SystemExit(0)
r=d['result']; rt=r.get('runtime') or {}
print('%-11s stored=%-11s resolved=%-11s found=%-5s path=%s' % ('$FW', '$STORED', r.get('agentFrameworkId'), rt.get('found'), rt.get('path')))")
  echo "$LINE"
  PATHS="$PATHS
$(echo "$LINE" | sed -n 's/.*path=//p')"
done

DISTINCT=$(printf '%s\n' "$PATHS" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')
echo "distinct_paths=$DISTINCT (应为 4)"
[ "$DISTINCT" = "4" ]
