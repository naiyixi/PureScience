# 删除会话前的「运行数据」读数（2026-10-21）

一句话：**删除会话的确认框过去对「会一并删掉多少分析结果」只字不提，而本机真实安装里单个会话的运行数据是 1.19 GB。**
本片让确认框先量一次再说话，三态各自具名；读不到就说「无法测量」，不冒充「没有」。

## 一 为什么这条不是文案改动

会话删除会连带释放 `<dataRoot>/notebooks/<projectId>/<sessionId>`（`deleteSessionNotebookData` 已有此行为）。
证据档 `2026-10-21-*` 之前的台账把「删除不清理会话级运行数据」列为已修，但**删除前的告知**一直缺：
用户在不可逆动作上看到的是「这会删除 <标题>」这一句，运行数据那一半从未出现在决策点上。

## 二 交付形状

| 层 | 落点 | 行为 |
|---|---|---|
| 主进程 | `src/main/notebook/session-data-cleanup.ts` 新增 `measureSessionNotebookData` | **与删除同一处铸造路径、同一道 id 边界**（`SAFE_ID_SEGMENT`）；三态 `measured{bytes}` / `absent` / `unavailable{reason}` |
| 主进程 | `src/main/session-persistence/ipc.ts` 通道 `sessions:read-notebook-usage` | 读取器**注入边界**（`SessionNotebookUsageReader`）；默认实现每次调用现取 `resolveDataRoot()`（会话中途换根不会指向旧树），抛错落 `unavailable/unreadable`，**永不落 `absent`** |
| 预载/契约 | `sessions.readNotebookUsage` + `renderer-api.d.ts` + 契约目录 + 生成物 | 计数连锁 7 处一次改齐（见 §四） |
| 渲染层 | `pages/workspace/use-session-notebook-usage.ts` | 读数**盖会话 id 戳**：换会话时旧数字不会被贴到另一个标题旁（同步清空会撞 `react-hooks/set-state-in-effect`）；读失败 → `unavailable` |
| 渲染层 | `lib/session-deletion-notice.ts` `sessionNotebookUsageMessage` | 四态文案：有读数（带体积）/ 零产出 / 无法测量 / 无读数可讲（`null`，调用方不渲染） |
| 渲染层 | `pages/workspace/DeleteSessionDialog.tsx` | 第二段描述，锚点 `data-slot="delete-session-run-data"` |
| 九语 | `i18n/{en,zh,zh-Hant,de,es,fr,ja,ko,ru}.ts` | 3 键 × 9 语；zh 值与 en 值不同形 |

## 三 真读数（产品自己的测量函数，只读，跑在本机真实数据根上）

用产品自己的 `measureSessionNotebookData()`（不自己拼路径、不自己遍历）：

```
PROBE cmutflcqb… e26108e7…  {"state":"measured","bytes":1195071853}   4 ms   ← du -sk 同目录 1,167,268 KB（1.1 GB）
PROBE cmus6s5yx… 026279b9…  {"state":"measured","bytes":1044975508}   1 ms   ← du -sk 同目录 1,020,560 KB（997 MB）
PROBE cmv0zlg6t… no-such-session            {"state":"absent"}        0 ms
PROBE ../escape  e26108e7…                  {"state":"unavailable","reason":"unsafe-id"}  0 ms
```

- 两个 `measured` 与 `du -sk` **同量级且逐目录对得上**（差值来源是口径：产品按文件字节求和，`du` 按块）。
- `absent` 与 `unavailable` 分开命名：不存在的目录 ≠ 读不了。
- 路径穿越按**名**拒绝（`unsafe-id`），且拒绝发生在任何文件系统调用之前。

**这条读数的分量**：本机真实安装里存在**单个会话 1.19 GB** 的运行数据，而旧确认框对此一个字都没说。

## 四 门禁（全部实跑；数字取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 全量 vitest `--maxWorkers=4` | **1361 passed \| 16 skipped（1377 文件）**；**17,345 passed \| 207 skipped（17,552 例）**；exit 0 |
| 定向 vitest（本单元 13 个目录/文件簇） | **312 passed \| 8 skipped（320 文件）**；**4,130 passed \| 99 skipped（4,229 例）**；exit 0 |
| 双 typecheck（`--composite false`，堆 8192） | node **0 error**；web **0 error** |
| `eslint --no-cache`（本笔 30 文件） | **0 error**；1 warning 落在 `src/preload/index.ts:554`（**既有行、不在本笔 hunk 内**） |
| `scripts/pre-push-checks.sh` | **exit 0**，8 段全过（品牌扫描零命中） |

契约计数连锁（一次改齐，不是逐个撞）：`application-command-composition.ts` INTERNAL 368→369 / LOCAL_WEB 366→367 /
REMOTE_WEB 235→236（fail-closed 仍 131）；契约目录 497→498、invoke 投影 374→375、local-Web 可调用面 404→405；
`renderer-surface-inventory` electronPaths 497→498、`WEB_INVOKE_CHANNELS` 374→375；preload 可调用清单补一条、
coreContracts 252→253、requests 214→215；数据内容命令表 55→56。

## 五 两处只有全量/真渲染才暴露的坑（都已按「补桩、不改断言」处置）

1. `session-dialogs.render.test.tsx` 是**直呼组件**的结构测试：把 `useState/useEffect` 写进对话框后它当场
   `Cannot read properties of null (reading 'useState')`。正解不是改断言，而是把读取抽成独立 hook 并 `vi.mock` 掉
   （与该文件已 mock `use-retained-dialog-value` / `dialog-focus-restore` 同一约定），真读取由新写的 jsdom 用例覆盖。
2. `ArchivedPanel.render.test.tsx` 的 `window.api.sessions` 夹具缺新方法，永久删除归档会话那条用例炸
   `readNotebookUsage is not a function`。**给夹具补桩**，没有在组件里加防御分支（那会把契约悄悄降级）。

## 六 边界（不许读成更强）与具名未办

1. **只有一态是说「有东西要丢」**：`measured` 且 `bytes > 0`。`absent` 说「本会话没产出运行数据」，
   `unavailable` 说「测不了，产出的会随会话删除」——两句话含义不同，不许合并成一句。
2. **这不是进度条式估算**：读的是真实目录字节，不是「会话里有几个 notebook 单元格」的推断。
3. **真窗口读数未取（具名）**：`blocked-by` = 内存闸门。本轮现取：空闲页 **7,115 ≈ 111 MB**、
   `swap used 13.5 G / 14.0 G`，机器上跑着打包版实例与 dev Electron（14 小时）。
   解封后第一件事：`npm run build:e2e` → 打开一次删除确认 → 按 `data-slot="delete-session-run-data"`
   取三态各一次（有数据 / 无数据 / 测不了）。**在此之前不声称任何对话框在真窗口里的读数。**
4. **会话删除本身的行为没动**（`deleteSessionNotebookData` 一个字节未改），本片只补「删除前的话」。

## 七 复现入口

- 主进程读数：`sessions:read-notebook-usage`，入参 `{projectId, sessionId}`，返回上述四态之一。
- 渲染层文案映射：`sessionNotebookUsageMessage(usage, lang, t)`（`src/renderer/src/lib/session-deletion-notice.ts`）。
- 单测：`src/main/notebook/session-data-cleanup.test.ts`（含 `unsafe-id` 与 `absent` 两态）、
  `session-notebook-usage.unreadable.test.ts`（读失败 → `unavailable`）、
  `DeleteSessionDialog.render.test.tsx`（四态各自的屏上文字与「`null` 时不渲染」）。
