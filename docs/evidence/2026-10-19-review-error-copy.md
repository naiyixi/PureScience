# 审查卡片的失败态：把 Prisma 原文换成一句人话，原文仍作证据留着

取数日期 2026-10-19。仓库 `naiyixi/PureScience`，基点 `f4a5eba8`（origin/main）。

## 1. 缺陷与它的真机读数

面板此前把 `Review.errorMessage` 原样上屏（展开后是一个等宽块）。装好的 `/Applications/PureScience.app`
自己的库里，`lifecycle='error'` 的审查有 **5 条、4 种不同原文**：

| # | 原文（截断处为该条真实结尾） | 读者实际看到的是什么 |
| --- | --- | --- |
| 1 | `Internal error: API Error: 402 Insufficient Balance (request_id: 629b6429-…)` | 一句英文加一个 request id |
| 2 | `Reviewer stopped without calling submit_findings.` | 内部协议名 |
| 3 | `ACP connection closed`（2 条） | 传输层缩写 |
| 4 | `Invalid `` `tx.review.update()` `` invocation in /Applications/PureScience.app/Contents/Resources/app.asar/out/main/ipc-CLnmvMls.js:2029:23 … Transaction API error: Transaction already closed: … The timeout for this transaction was 5000 ms, however 6692 ms passed…` | 打包产物内部的绝对路径 + 一段指到代码行的 ORM 报错 |

第 4 条最糟：它把「这一轮到底有没有被检查」这个问题，换成了「第 2029 行是什么」。而且这一类**正是最需要
说清楚的一类**——判决已经产出、只是没落库，重跑一次大概率就好。

开发实例的库里另有第 5 种：`reviewer session timed out before stopping`（超时族）。

## 2. 修法（分类器 + 九语一句话 + 原文保留）

- `src/renderer/src/lib/reviewer-error-copy.ts`：纯函数 `classifyReviewError(message)` → 七个族
  `persistence / storage / protocol / provider / runtime / timeout / unknown`。匹配串**逐条引用本仓
  生产者真的会写的字面量**（orchestrator 的三句、repository 的快照写失败、模型服务信封的 401/402/403/429、
  ACP 客户端的中断），匹配顺序有契约意义：落库失败的原文里**自己带着** `The timeout for this transaction
  was 5000 ms`，所以 persistence 必须排在 timeout 之前，否则会把「判决已产出但没存下」误读成「太慢没跑完」。
- 认不出的原文一律 `unknown`：只说「本面板不认识这个原因」，不猜族。原句、原文两者都在屏上。
- `ReviewerCard`：折叠行由「审查出错」变成「审查出错 · 判决未落库」（族短标签），展开后先一句能行动的
  说明（`data-testid="reviewer-error-plain"`），再把原文放进带 `Technical details` 标签的块
  （`data-testid="reviewer-error-detail"` 仍在原容器上——解释原文，不替换原文）。
- 文案 15 键 × 9 语（7 长句 + 7 短标签 + 1 标签），`scripts/add-i18n-keys.py` 写入并自证九文件齐平。

## 3. 读数

| 项 | 读数 |
| --- | --- |
| 分类器用例 `reviewer-error-copy.test.ts` | 5 条真机原文各自一条 + 顺序（persistence 不被 timeout 抢）+ 快照写失败独立成族 + `unknown` 不借别人的句子 |
| 渲染用例 `ReviewerCard.render.test.tsx` | **58 passed**（原 56 + 新 2）；折叠行含 `Review error · verdict not saved` 且**不含** `Invalid `` `tx. ``；展开后 plain 句子在位、原文仍在 |
| **反向门** | 把 `ReviewerCard.tsx` 换回旧实现 ⇒ 新用例红在 `expected 'Reviewer·Review error' to contain 'Review error · verdict not saved'` |
| **真机读数**（`e2e/certification/reviewer-error-copy.spec.ts`，真窗口 + 真 Prisma 行 + 真重读） | **1 passed (14.1s)**。折叠行 `Reviewer · Review error · verdict not saved`；plain 句 `The verdict was produced but could not be saved to this project, …`；技术块 **514 字符**、含 `Transaction already closed` |
| 定向 vitest（模块 + 卡片 + i18n 全套） | **6 文件 / 120 passed** |
| 全量 vitest（隔离工作树 `/tmp/ps-reviewerr`，`--maxWorkers=4`） | **1343 文件通过 / 16 跳过（共 1359）；17170 用例通过 / 207 跳过（共 17377）；EXIT=0**，426.8 s |
| 双 typecheck | node / web 各 **EXIT=0** |
| 全仓 lint（CI 同口径 `--no-cache .`） | **0 error** / 129 warning（warning 数是仓库既有基线） |

## 4. 这轮咬到的三个坑（都不是产品缺陷，但都会把人引错方向）

1. **共享树里的 i18n 文件不是 main 的**。本机主工作区停在一条与远端分叉的本地 `main`（10 笔未推、落后远端
   95 笔），它的九语字典比 main **少 139–148 行**。把那份 `en.ts/zh.ts` 拷进基于 `f4a5eba8` 的隔离工作树后，
   `tsc -p tsconfig.web.json` 一次报了 **125 个**「键不在联合类型里」的错，全落在别人负责的页面上
   （`KnowledgePanel.tsx` 65 条、`ArtifactProvenancePanel.tsx` 16 条…）。判据：错的文件我一个字没碰、
   而 `git diff f4a5eba8 -- zh.ts` 显示是**净删除**。修法＝在隔离工作树的 main 版本上重跑插键脚本，
   并把主工作区那 9 个文件还原。
2. **磁盘上的会话文件不再存 `messages`**。写入侧只落 `conversationGraph`（`messages` 是读时投影，历史文件
   才有数组）。spec 第一版按 `session.messages` 读，读到的 `messages=0` 而文档明明存在。修法＝用**产品自己的
   读路径** `normalizeSessionFile()`，不在这里写第二份投影实现。
3. **`text-transform: uppercase` 会改 `innerText`**。技术详情的标签实际渲染成 `TECHNICAL DETAILS`，
   断言 `toContain('Technical details')` 因此假红；改成正则 `/technical details/i`。

## 5. 边界与具名未办

- 本单元只治**渲染侧的说人话**，不治各族本身的故障率：`persistence` 的 30 s 预算与语句形状是上一轮
  `c8b5c409` 的事；`provider`（402 余额）与 `runtime`（ACP 断连）各有自己的成因，不在本轮。
- 分类依据是**原文文本**，不是结构化字段。这是刻意的连锁最小选择（加 `Review.errorKind` 要动 Prisma 迁移、
  契约目录与全部计数面）。代价：生产者若改写字面量，族会退化成 `unknown`——**退化是安全的**（不会误报原因），
  且 5 条真机原文已各自钉成用例，改字面量时会先红。
- 未取的读数：非英文界面下的真机卡片。分类器与字典在单测里逐语覆盖，真机读数只跑了英文窗口
  （`--lang=en-US`，本仓 e2e 的既定口径），这一格**姓「未取」不姓「通过」**。
