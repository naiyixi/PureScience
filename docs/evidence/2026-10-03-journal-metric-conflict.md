# 同一年份多条指标：两条都上屏（V11 / IC1 真机读数）

> 日期：2026-10-03。依据：`docs/plan-2026-10-03-v1.81.0-queue.md` 的 **V11**，源自
> `docs/evidence/2026-10-03-r2-u4-journal-alias-merge.md` §3 的实测发现——
> R2-U4 别名合并那次真机读数里，合入库带来的 `16.6 (2023)` 与原有的 `64.8 (2023)` **库里两条都在**，
> 而屏上只剩一个数字，读者无从知道同一年还有另一个值/另一个来源。
> 拍板口径：**并列显示（各带 source）或显式标出冲突，不许静默取一条**。

## 0. 结论

**已修，并取了真机读数；而且读数命中的正是当初发现该问题的那条路径（别名合并）。**
两次读数都在同一支认证 spec 里、同一台机器、同一个隔离实例上取得：

| 读数 | 通道/路径 | 窗口原文 |
| --- | --- | --- |
| ① 别名合并（原发现场景） | 真实合并 → 面板重读 | `Naturealso known as nature communications 0028-0836 Unknown Unknown Unknown 16.6 (2023 · Journal Citation Reports) also 1 also 64.8 (2023 · Journal Citation Reports) Unknown` |
| ② 同刊同源冲突（新增用例） | 走用户导入路径造两条同年主张 | `Nature 0028-0836 Unknown Unknown Unknown 16.6 (2023 · CAS journal metrics) also 1 also 64.8 (2023 · Journal Citation Reports) Unknown` |

两处都**同时**出现两个值 + 各自的 source，并带冲突标记 `also 1`（`data-testid="journal-metric-conflict"`，
备选行 `data-testid="journal-metric-alternative"` 计数 1）。辅证：真实库里合并后
`claims: [{journalId: 'cmus8mj62…', value: '64.8'}, {journalId: 'cmus8mj62…', value: '16.6'}]` —— **两条都在**，
所以屏上看到两个值是事实的投影，不是渲染巧合。

## 1. 改了什么（纯视图层，无新通道、无迁移）

- `src/shared/journal-metrics-overview.ts`：新增 `JournalMetricAlternative` 与
  `selectClaimWithAlternatives()`。**选中规则一字未改**（仍是「最新年份 → 同年比 `fetchedAt`」），
  变化只是把这次比较的**落败者**随 cell 一起交给渲染层：`state:'known'` 增 `alternatives` 字段，
  同值同源不算冲突（重导一张表不会被说成冲突），跨年份不进来（2022 的数字不是 2023 的竞争者）。
  备选按 `source` → `value` 排序，保证同一个库不会渲染出两种顺序。
- `src/renderer/src/components/references/JournalMetricsPanel.tsx`：主值行后并列打印每条备选，
  各带自己的年份与来源，并加一个冲突徽标（`title` 说明「同一年有多个来源的值，下面全部列出」）。
- i18n：3 键 × 9 语（`references.journalMetrics.conflict{Badge,BadgeTitle,Line}`），zh ≠ en。
- 未新增 IPC/preload/契约：`alternatives` 走既有的 `listJournalMetrics` 载荷，所以**零契约计数涟漪**
  （`check:web-api-map` 不受影响）。

## 2. 真机读数怎么取的（可复跑）

```bash
launchctl unload ~/Library/LaunchAgents/com.totota.purescience.plist   # 本机该步报 I/O error，见 §4
npm run build:e2e                                                       # 改过 renderer ⇒ 必须重建，否则读数属于旧版本
npx playwright test e2e/certification/journal-metrics-panel.spec.ts --workers=1
# → 4 passed (32.9s)
```

新增用例 `one year with two claims shows both values, each with its own source`
（`e2e/certification/journal-metrics-panel.spec.ts:419`）用**应用自己的** `importJournalMetrics` 造两条同年主张
（先 `64.8 / Journal Citation Reports`，再 `16.6 / CAS journal metrics`，同刊同 kind 同年），
然后如实断言：`imported: 2`、库里 `claims: 2`、窗口同一行里同时含 `64.8`、`16.6` 与两个 source 名，
冲突标记可见、备选行恰好 1 条。截图 `2026-10-03-journal-metric-conflict.png`。

## 3. 收尾复核（本次实测数字）

- 真实数据根 `~/.purescience-project/purescience.db`：`Journal = 0`、`JournalMetric = 0`、无 `JournalAlias` 表
  ⇒ **本次 e2e 一条都没写进真实库**（隔离根生效）。
- 本次 playwright 实例已自行退出：`pgrep -fl "node_modules/electron"` 只剩 4 个进程，
  且它们是**先前会话**的 headless 实例（`--purescience-headless --serve=44100`，
  `--user-data-dir=…/PureScience (DEV)`），**不是本次的**；本次实例用的是临时 user-data 根，已随测试结束回收。
- 用户安装版应用（`/Applications/PureScience.app`，pid 170 及其 MCP 子进程）**未动**。
- `launchctl unload` 报 `Input/output error`（该 LaunchAgent 当时状态不允许从会话内卸载），
  故本次未做「卸下 → 验证 → 装回」这套；**如实记下**，不声称做过。
- 工作区：`git status` 仅含本次改动 + spec 顺带重写的品牌色截图 `2026-10-03-primary-brand-blue.png`（同一断言的新一份捕获）。

## 4. 明确没做 / 已知边界

- **不做**自动合并或按值取大的「智能裁决」：两条不同来源的数字是**两个事实**，让程序替研究者选一个才是造假。
- **不做**冲突的持久化状态（如「已确认以哪条为准」）：本轮只解决「不许静默」，标记人工裁决是另一个功能，
  需要迁移与入口，未立项。
- 表格单元格因此可能变成两行；窄窗下的排版未单独取读数（本片只验内容与标记）。
