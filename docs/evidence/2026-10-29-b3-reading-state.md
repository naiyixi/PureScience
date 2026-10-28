# B3 阅读状态：三态 + 过滤 + 「已引用未读」点名（2026-10-29）

## 0 结论

`readingStatus` 在全仓命中 **0**，是新建项。本轮把它做成一条完整链路：词汇表 → 落库（含运行时 DDL）→
一条 IPC 写入通道 → 文献库三态控件 / 过滤器 / 点名条 → 九语界面文案；并用独立 headless 实例在真机上跑通
「建项目 → 加 2 条 → 标 reading → 标 read → 重读列表 → 库内直读」。

## 1 为什么是三态而不是布尔

- `reading` 与 `unread` 的可执行动作不同（继续读 vs 开始读），布尔会把两者折成一个；
- 点名条要的是「正文引用了但没读完」：**在读也算没读完**，布尔无法表达；
- 记录没有存值时必须读作 `unread`（加列前的历史记录语义不变），布尔则会在「没标」和「标了未读」之间造歧义。

词汇表单一来源：`src/shared/references-reading.ts`（`REFERENCE_READING_STATUSES`、`isCitedNotRead`、
`countCitedNotRead`、`matchesReadingFilter`）。过滤器与点名条共用同一个谓词，两者不可能对同一批记录给出不同答案。

## 2 契约面（按 references/contract-surfaces.md A 节八面）

| #   | 面            | 动作                                                                                          |
| --- | ------------- | --------------------------------------------------------------------------------------------- |
| 1   | 契约目录      | `['setReadingStatus', 'references:set-reading-status']`（普通写，两 Web 面都计入）            |
| 2   | 生成物        | `npm run gen:web-api-map`（`check:web-api-map` 绿）                                           |
| 3   | preload＋d.ts | `setReadingStatus` invoke 与类型                                                              |
| 4   | preload 清单  | 字母序清单 + 三个计数（core 256 / requests 218 / callable paths 501）                         |
| 5   | 应用命令      | 名称联合、`defineApplicationCommand`、组内登记、`OwnerArgs/OwnerResult` 白名单、handler       |
| 6   | 命令计数      | internal 372 / local-web 370 / remote-web 238（rejected 131 不变）                            |
| 7   | 其余 pin      | 目录 501、invoke 映射 378、表面清单 501、Web 可调用面 408、screening-ipc 清单                 |
| 8   | 运行时库      | `readingStatus TEXT`、`readingStatusUpdatedAt DATETIME` ＋ 两条 ALTER ＋ `addColumnIfMissing` |

## 3 界面（ReferencesLibraryDialog）

- 每行一个三态下拉（未读/在读/读完），写入回来后用**返回的记录**替换该行（不是本地猜一个值）；
- 工具栏一个过滤器（全部/未读/在读/读完/已引用但未读）；
- 点名条：`正文已引用但未读 N 条`（N 只在 >0 时出现），点它把过滤器切到 `cited-not-read` —— 这个视图**宽于**「未读」：
  带 `reading` 的记录也算，因为「在读」不等于「已读」。这条差异在实现中真实踩到过一次（初版把点名条接到 `unread`，
  渲染用例当场红，因为计数是 2 而列表只显示 1 条）。

## 4 验证读数

### 4.1 单测/集成

| 范围                                                       | 结果                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/shared/references-reading.test.ts`（新增）            | 3 例：缺省/未知值读作 unread、cited 未读含 reading 但排除 read、过滤器与点名同源                                 |
| `reading-status-storage.test.ts`（新增，database 组）      | 2 例：真实 SQLite 上未标记录无值 → 标 reading → 标 read → 重读仍在；相邻记录不受影响                             |
| `ReferencesLibraryDialog.render.test.tsx`                  | 新增 3 例：标 read 调通道并用返回值刷新行、过滤器按阅读态筛选、点名条计数为 2 且点开后同时显示 unread 与 reading |
| 契约/计数/分区/表面清单相关 7 个套件                       | 全部随 +1 更新后通过（2036 例）                                                                                  |
| `tsc` node + web、`eslint`（32 文件）、`check:web-api-map` | 0 错                                                                                                             |

### 4.2 真机链路（`out/` 生产构建 + 独立 headless，端口 44665，`readiness=200`）

| 步骤                                        | 读数                                            |
| ------------------------------------------- | ----------------------------------------------- |
| 建项目                                      | `project=cmvsc0yy70000jtzni4h496b5`             |
| 初始列表                                    | `Ref1 (none)`、`Ref (none)` —— 两条都没有阅读态 |
| `references:set-reading-status` → `reading` | `Ref1 reading 1793205116356`                    |
| 再 → `read`                                 | `Ref1 read 1793205116386`（时间戳随写入变化）   |
| 重读 `references:list`                      | `Ref1 read 1793205116386`；另一条仍 `(none)`    |
| 库内直读 `Reference`                        | `Ref1                                           | read | 1793205116386`、`Ref | -   | -`  |

## 5 尚未做（明确立案）

- **打包版 UI 点击**：本轮的界面行为由渲染用例钉住，但 `/Applications/PureScience.app` 尚未重装本轮构建，
  所以「在真实窗口里点三态、看点名条、点过滤器」这一步未做，不并入已完成。
- **引用联动标黄**：计划档 B3 原文含「与正文引用联动标黄」。本轮做的是「正文已引用却被读到哪一步」的**记录与点名**；
  正文里的引用标记渲染成黄色这一层尚未接入（`citedAt` 已有，缺的是正文渲染侧的样式钩子），保留在 B3 尾巴。
- **筛选下推到查询**：过滤在渲染层做（列表本来就整包返回），记录数到数千条时需要把 `readingStatus` 下推到仓储查询并加索引。
