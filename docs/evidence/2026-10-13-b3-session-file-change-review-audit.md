# B3 会话内文件变更审阅 —— 前提核定与切分（2026-10-13）

## 一 前提核定的三轮读数（前两轮都是仪器错，逐条留证）

| 轮 | 用的标记 | 读数 | 结论 |
| --- | --- | --- | --- |
| 1（早前勘查） | `file-change` / `diffReview` | 渲染层 **0** | 判「前提未复现」 |
| 2（本轮） | `fileChange`（无词边界） | 渲染层 **54**、`reviewPanel` 149 | 差点改判成「概念已存在」 |
| 3（定谳） | `FileChange\b`（允许前缀）+ 逐个排除 | `profileChange`/`onPermissionProfileChange` 属**子串假阳** | 唯一真命中＝字典键 `ws.fileChange`（9 语，**零消费者**）+ 审批卡里的 `ws.thisFileChange`（一句「这次文件变更」的措辞） |

**定谳**：渲染层**没有**会话级文件变更审阅面。两处假读数的成因各记一条：① 第 1 轮用了**能力名**（`file-change`/`diffReview`）而不是**标识符**；② 第 2 轮用了**无边界**的驼峰词，`proFileChange`/`onPermissionProfileChange` 全被算进去（`grep` 是大小写敏感但**子串**匹配）。→ 结论：核实这类前提必须**两向都试**（裸词 + 词边界/前缀），并且**逐个命中回读来源文件**才算数。

## 二 数据面现状（决定 B3 是「投影」还是「新记录」）

| 面 | 今天的字段 | 有没有内容哈希 |
| --- | --- | --- |
| 逐运行写入轴 | `NotebookWorkingFile`: `path` / `relativePath` / `kind` / **`changeKind: created\|modified\|removed`** / `size` / `mtimeMs` / **`createdByRunId`** | **无** |
| 逐运行读写证据 | `NotebookRunFileEvidence { read, write }`（含具名缺态 `driver-without-read-capture` / `kernel-language-unsupported` / `capture-failed` / `limit-exceeded` / `observation-unavailable`） | **无** |
| 逐回合输入 | `inputFiles` / `input-registry`（版本 + 内容存储键） | 输入侧有版本，**变更侧无** |
| 全树 `hash` 词频 | 只有 B1 风险收据的 `codeHash` | — |

**判定**：B3 的判据「每条变更 = 路径 + **前后内容哈希** + 变更来源回合」**不能靠投影现有记录得出** —— 变更的**前/后内容摘要从来没被记过**（`changeKind` 只是三态标签，`size/mtimeMs` 不是内容身份）。⇒ B3 = **两片**：数据（写入轴补内容摘要）＋ 面（审阅面板）。这**不是**「架构已覆盖」的零代码项，也不是「新建面板」这么轻。

## 三 切分（本版范围不变，落点已定）

| 片 | 落点 | 完成判据 |
| --- | --- | --- |
| **B3-1 数据** | `src/main/notebook/working-file-observer.ts`（已逐运行观测写入 ⇒ 在那里取**后**态内容摘要；**前**态只有观测到的才记）+ `src/shared/` 契约（摘要字段 + **具名缺态**：`not-captured` / `too-large` / `unreadable`，三者各自有话，**不许把「没记」写成「没变」**） | 同一文件两次运行 → 记录里两条各自的路径 + 前后摘要（或各自具名缺态）；从运行记录可复算 |
| **B3-2 面** | 新面板（走既有 workspace 面，不新建浮层宿主）：路径 + 前后摘要 + **来源回合**；引用格式与既有 `search-evidence` 同规（配方常量 + 形状 + 判决在共享层，摘要计算只在主进程） | 面板列出本次会话的变更，三种缺态各自有话，9 语 |

## 四 与并发执行器的关系（本轮实际形状）

- 执行器**正在做 B2**（`src/shared/run-alias-lineage.ts` 14.6K + 渲染端 `notebook-stale-copy.ts` + `NotebookPreview.stale-lineage.render.test.tsx`，22:17 落盘、**未提交**；另在改 `NotebookPreview.tsx` 与 `run-risk-rules.ts`）。
- 纪律：**不碰**上述任一在制路径；B3 的落点（`working-file-observer.ts` + 新面板）与它不相交 ⇒ 可并行。
- **一个时序约束**：B3-2 需要向 9 个字典插键，而执行器正在做 stale 文案（很可能要插 `notebookStale.*` 键）⇒ 插键动作要**等它的 i18n 落定**（`git status --short | grep i18n` 为空再动），否则会把它的未提交改动写进我的提交。
