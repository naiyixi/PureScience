#!/bin/bash
# Per-turn cost probe: same app, same machine, notice OFF vs ON.
# Only the capability-gap notice differs, so the delta is attributable to it.
set -u
cd ~/purescience || exit 1
PROJECT=cmvgyik9y0002wf625wgx5do6
OUT=docs/bench-runs

probe() {
  local label="$1" notice="$2" port="$3" root="/tmp/ps-lat-$1"
  chmod -R u+w "$root" 2>/dev/null; rm -rf "$root"; mkdir -p "$root"
  rsync -a /tmp/ps-v2153-root/ "$root"/
  rm -rf "$root/electron-userdata"
  pkill -9 -f "$root/electron-userdata" 2>/dev/null; lsof -ti ":$port" 2>/dev/null | xargs -r kill -9 2>/dev/null; sleep 2

  local t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  if [ "$notice" = "on" ]; then
    PURESCIENCE_CAPABILITY_NOTICE=on \
    PURESCIENCE_CONFIG_ROOT="$root" PURESCIENCE_STORAGE_ROOT="$root" \
    PURESCIENCE_WEB_PORT="$port" PURESCIENCE_AGENT_FRAMEWORK=opencode \
    node_modules/.bin/electron . --purescience-headless --disable-gpu \
      --user-data-dir="$root/electron-userdata" > "$root/run.log" 2>&1 &
  else
    PURESCIENCE_CONFIG_ROOT="$root" PURESCIENCE_STORAGE_ROOT="$root" \
    PURESCIENCE_WEB_PORT="$port" PURESCIENCE_AGENT_FRAMEWORK=opencode \
    node_modules/.bin/electron . --purescience-headless --disable-gpu \
      --user-data-dir="$root/electron-userdata" > "$root/run.log" 2>&1 &
  fi
  local app=$!

  local tok=""
  for i in $(seq 1 150); do
    tok=$(grep -o 'token=[A-Za-z0-9_-]*' "$root/run.log" 2>/dev/null | head -1 | cut -d= -f2)
    [ -n "$tok" ] && break
    sleep 1
  done
  [ -z "$tok" ] && { echo "{\"probe\":\"$label\",\"error\":\"no_token\"}"; kill -9 $app 2>/dev/null; return 1; }

  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "authorization: Bearer $tok" "http://127.0.0.1:$port/api/v1/projects")
    [ "$code" = "200" ] && break
    sleep 1
  done
  local t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  local readyMs=$((t1 - t0))

  # Three trivial turns: the per-turn hook (if any) runs on each.
  local times=()
  for n in 1 2 3; do
    local a=$(python3 -c 'import time;print(int(time.time()*1000))')
    curl -s -m 180 -X POST -H "authorization: Bearer $tok" -H 'content-type: application/json' \
      -d "{\"project\":\"$PROJECT\",\"prompt\":\"只回复 ok，不要用任何工具。\",\"permissionProfile\":\"full\"}" \
      "http://127.0.0.1:$port/api/v1/runs" > "$root/run-$n.json"
    local rid=$(python3 -c "
import json,sys
try: print(json.load(open('$root/run-$n.json')).get('data',{}).get('id',''))
except Exception: print('')
")
    for j in $(seq 1 90); do
      st=$(curl -s -m 10 -H "authorization: Bearer $tok" "http://127.0.0.1:$port/api/v1/runs/$rid" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print((d.get('data') or {}).get('status','?'))
except Exception: print('?')
")
      [ "$st" = "completed" ] || [ "$st" = "failed" ] && break
      sleep 1
    done
    local b=$(python3 -c 'import time;print(int(time.time()*1000))')
    times+=($((b - a)))
  done

  local notices
  notices=$(grep -c 'capability gaps notice' "$root/run.log" 2>/dev/null || true)
  notices=${notices:-0}
  echo "{\"probe\":\"$label\",\"notice\":\"$notice\",\"readyMs\":$readyMs,\"turnMs\":[$(IFS=,; echo "${times[*]}")],\"notices\":$notices,\"loadAvg\":\"$(sysctl -n vm.loadavg | tr -d '{}')\"}"
  kill -9 $app 2>/dev/null
  chmod -R u+w "$root" 2>/dev/null
}

{
  probe notice-off off 44931
  probe notice-on  on  44932
} | tee "$OUT/latency-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
