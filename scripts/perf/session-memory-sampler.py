#!/usr/bin/env python3
"""Sample the Electron process tree's resident memory while a long-session perf spec runs.

Why a sampler and not a spec assertion: the reading wanted is "how much does a 40-turn
session cost in memory", and the peak only exists while the tree is up. Playwright tears
the app down before it reports, so the sample has to be taken from outside.

Same measurement discipline as `scripts/perf/startup-timeline.mjs`:
  * tree = the Electron processes launched from this worktree, plus all descendants
    (main + renderer + GPU + utility), so a renderer-side regression cannot hide;
  * `rss` (KB from ps) is summed and printed in MB. It is comparable only against another
    run of this same command: it double-counts shared libraries, so it is NOT the number
    Activity Monitor shows and must never be compared across tools;
  * the absence of samples is reported as `null`, never as 0.

Usage (from the repo root, after `npm run build:e2e`):
    python3 scripts/perf/session-memory-sampler.py [turns]

Output: one JSON line with samples/peakMb/lastMb plus the spec's own scroll readings.
"""
import json
import os
import subprocess
import sys
import time

WORKTREE = os.getcwd()
RUNNER = "Electron.app/Contents/MacOS"  # macOS bundle entry; other platforms print null
SAMPLES = []
INTERVAL_S = 1.5


def snapshot():
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid,ppid,rss,command"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return None
    rows = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        rows.append((parts[0], parts[1], int(parts[2]), parts[3]))
    children: dict[str, list[str]] = {}
    rss_by_pid: dict[str, int] = {}
    for pid, ppid, rss, cmd in rows:
        children.setdefault(ppid, []).append(pid)
        rss_by_pid[pid] = rss
    roots = [
        pid
        for pid, _ppid, _rss, cmd in rows
        if WORKTREE in cmd and "electron" in cmd.lower() and RUNNER in cmd
    ]
    if not roots:
        return None
    seen: set[str] = set()
    stack = list(roots)
    total = 0
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        total += rss_by_pid.get(pid, 0)
        stack.extend(children.get(pid, []))
    return round(total / 1024)


def main() -> int:
    turns = sys.argv[1] if len(sys.argv) > 1 else "40"
    env = {**os.environ, "PERF_WAIT": "selector", "PERF_TURNS": turns}
    log_path = "/tmp/ps-session-memory.log"
    with open(log_path, "w") as log:
        proc = subprocess.Popen(
            ["npx", "playwright", "test", "e2e/perf/smoothness.spec.ts", "--reporter=line"],
            cwd=WORKTREE,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        while proc.poll() is None:
            reading = snapshot()
            if reading is not None:
                SAMPLES.append(reading)
            time.sleep(INTERVAL_S)
        exit_code = proc.returncode

    scroll = []
    with open(log_path) as log:
        for line in log:
            if "scrolling the transcript" in line or "passed" in line or "failed" in line:
                scroll.append(line.strip())

    print(
        json.dumps(
            {
                "turns": turns,
                "specExit": exit_code,
                "samples": len(SAMPLES),
                "peakMb": max(SAMPLES) if SAMPLES else None,
                "lastMb": SAMPLES[-1] if SAMPLES else None,
                "series": SAMPLES[::4],
            },
            ensure_ascii=False,
        )
    )
    for line in scroll[-3:]:
        print(line)
    return 0 if SAMPLES else 1


if __name__ == "__main__":
    raise SystemExit(main())
