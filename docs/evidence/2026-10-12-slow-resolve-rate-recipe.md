# 慢解析出现率：可复跑的读法（P0-10③ 第三步的判据，2026-10-12）

> 用途：判定"WAL 够不够、要不要上只读连接"的唯一依据是**慢解析的出现率**，而不是某一次单跑。
> 这份文件把读法固定下来，免得下一轮又要重新想一遍口径。

## 这些条目**没有时间戳**（先看清形状再定口径）

日志里那一条是多行 JSON 块、由 `[artifact-provenance]` 前缀的**块头行**引出：

```
[artifact-provenance] artifact version resolve was slow {
  clientMs: …,
  queryMs: …,
  dbCanaryMs: …,
  readMs: …,
  bytes: …
}
```

⇒ **不能用时间戳切窗口**。窗口只能由两样东西给出：
① 日志文件的 mtime / 轮转（粗到文件级）；② **位置**（最后一次启动标记之后的行）。

**反面教材（我本轮踩过）**：先用 `"time":"…"` 过滤，取不到值 ⇒ 过滤结果恒为空 ⇒ 打出"重启后 0 次"。
**那是一个假读数**：它不是"没有慢解析"，而是"我的过滤器没工作"。任何"按某个字段切窗"的读法，
必须先证明**该字段真的存在**（先打印一行原样）。

## 读法（可复跑）

```bash
cd <repo>
python3 - <<'PY'
import io
lines = io.open('logs/headless.out.log', encoding='utf-8', errors='replace').read().split('\n')
# 启动标记：本实例起点（这两条只在该实例启动时打）
marks = [i for i, l in enumerate(lines)
         if ('package cache redundancy' in l or 'data root resolved' in l or 'compose-runtime' in l)]
start = marks[-1] if marks else 0
cnt = lambda a, b: sum(1 for l in lines[a:b] if 'artifact version resolve was slow' in l)
print('总行数', len(lines), '| 启动后行数', len(lines) - start)
print('启动后慢解析块头行数', cnt(start, len(lines)), '| 全日志', cnt(0, len(lines)))
PY
# WAL 是否引入锁错误（期望 0）
grep -c -iE 'SQLITE_BUSY|database is locked' logs/headless.out.log
```

## 本次读数（2026-10-12，WAL 已生效的那个实例）

| 指标 | 读数 |
|---|---|
| 日志总行数 | 95,854 |
| 最后一次启动标记位置 | 第 95,305 行（其后 550 行） |
| **本实例启动后**慢解析块头行数 | **8** |
| 全日志慢解析块头行数 | 50 |
| `SQLITE_BUSY` / `database is locked` | **0** |

- **`SQLITE_BUSY = 0`** 是本次改动的一条有价值的**阴性读数**：切到 WAL 后没有引入锁错误。
- 那 8 次出现在**没有用户流量**的实例里（启动维护/走查期间）⇒ 说明"按行数归一"的窗口必须**同口径**比较
  （要么每次都比"启动后 N 行内"，要么固定一段有真实使用的时段）。**分母不可省**：只报绝对次数会在不同长度的窗口上得出不同结论。
- 打包版的历史基线（`~/Library/Logs/PureScience/main*.log`，**9 天 273 次**）来自**另一个日志族**，
  且窗口由**轮转文件的 mtime** 给出（`main.2.log` 09-21 → `main.1.log` 10-04 → `main.log` 10-10），
  不是条目时间戳 —— 引用时必须同时给出这两件事。
