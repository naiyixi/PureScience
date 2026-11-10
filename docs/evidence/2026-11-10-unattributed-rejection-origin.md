# 六条 unhandledRejection 认不出是谁抛的：记录只留了内置模块那一帧

> 单元范围：**进程级失败记录的可归因性**（`src/main/crash-diagnostics.ts`）。读数取自用户自己机器上打包版
> 应用的主日志（`~/Library/Logs/PureScience/main.log`，2026-11-09）。

## 一 读数

```bash
python3 - <<'PY'
import json
for line in open('/Users/totota/Library/Logs/PureScience/main.log', encoding='utf-8', errors='replace'):
    if '"unhandledRejection"' in line:
        d=json.loads(line); print(d['t'], json.dumps(d['data'], ensure_ascii=False))
PY
```

三条记录（同一签名被折叠，累计 **6 次**）：

```
2026-11-09T10:58:23Z unhandledRejection {"errorCategory":"not-found","errorName":"Error",
  "message":"ENOENT: no such file or directory, open '<path>'","frame":"async open (promises:1345:25)",
  "occurrences":1,…}
2026-11-09T11:08:14Z … "occurrences":5   (firstAt 10:58:23, lastAt 10:58:59)
2026-11-09T11:34:17Z … "occurrences":6   (windowMs 120000)
```

- **路径被脱敏是对的**（`<path>`），但**唯一的帧是内置模块那一帧**（`async open (promises:1345:25)`）⇒
  六次读失败，日志里没有一处能指出是**哪一处读**：这正是本仓反复吃的那一类「记录只记一半，读出来就是反结论」。
- 消息本身是可信的（`ENOENT`），所以这不是「没有信息」，而是**信息缺了归属那一半**。

## 二 交付

| 位置 | 改动 |
| --- | --- |
| `src/main/crash-diagnostics.ts` | 记录新增 `origin`：**第一个不属于运行时的栈帧**（`node:…`、`promises:1345:25` 这类无扩展名的模块名判为运行时）；`frame` 的语义一个字没改；签名把 `origin` 也算进去（两处站点共用同一个内置帧时不再被折叠成一条）；投影仍是「函数名 + 文件名 basename + 行:列」，绝对路径不出进程 |
| `src/main/crash-diagnostics.capture.test.ts` | 加三条：平常错误 `origin` 等于 `frame`；被内置帧包住的拒绝 `origin` 指到我方调用点；两处站点同消息同内置帧仍分成两条记录 |

判据：**能归因**（哪一处读）而**不多留一个字节的隐私**（仍是 basename）。

## 三 门禁

| 环 | 读数 |
| --- | --- |
| 定向 vitest（`crash-diagnostics.capture.test.ts` + `crash-diagnostics.test.ts`） | **2 files / 14 passed**（改动后重跑 11 passed 单文件） |
| `tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 |
| `eslint --no-cache`（本笔 2 文件） | **0 error**（1 条 prettier 折行，已 `prettier --write`） |

**变异自证**：把 `isRuntimeFrame` 短路成永远返回 `false` ⇒ 两条新用例当场红
（`names the caller…`、`keeps two sites apart…`）；还原后全绿。

## 四 边界与验收判据

- 本笔**不修**那个 ENOENT 本身：修之前得先知道是哪一处读，而本笔正是把「能知道」补上。
  下一版装出去之后：同机再出现这类拒绝时，记录应带 `origin`（形如 `async readFilePrefix
  (storage-access.ts:153:24)`），据此定位调用点并单独立案。
- 只在**新记录**上生效；旧日志里的那 6 次仍不可归因（这是读数，不是缺口）。
