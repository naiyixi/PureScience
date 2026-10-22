# 会话「有计划吗」改从指纹校验过的摘要层回答（2026-10-22）

## 一 问题（真语料读数，只读测量）

窗口每次打开都要回答一句话：「这个会话有计划吗」。改动之前，这个答案只能靠**整份会话 JSON 解析**得到。

本机真实数据根（`~/.purescience-project`，只读；脚本 `/tmp/ps-measure-summary-index.mjs`，不入仓）：

```
documents            67        会话文档合计 68,994,993 字节，单份最大 3,117,545
summaries            66        摘要件合计 639,192 字节
volumeRatio          107.9     会话文档 / 摘要件
fingerprintMatches   66/66     摘要件里的 size + mtimeMs 与盘上文档逐字相同
summariesWithRuntimeContext  1 其中只有 1 份带运行时上下文（也就是只有 1 份真的有 Plan）
```

⇒ **66 次里有 65 次**，产品为了得到「没有」这个答案，要把一份兆字节级的 JSON 整份解析掉。而列表层早就在每份文档旁边放着一条
**已被指纹校验过**的投影（体积小两个数量级、其中就带运行时上下文）。

## 二 改法（换答案来源，不换队列，不放宽任何判据）

| 位置 | 改动 |
|---|---|
| `src/main/session-persistence/repository.ts` | 新增 `loadRuntimeContextFromSummary(projectId, sessionId)` 与它的结果类型 `RuntimeContextIndexLookup`：读现成的摘要件（复用 `tryReadSessionSummary`，它自带 `size + mtimeMs` 指纹比对）⇒ 摘要在且指纹描述的就是当前字节 ⇒ `answered`；摘要缺席 / 指纹不符 / 摘要里的运行时上下文**过不了与文档读同一个 sanitizer**（`sanitizeSessionRuntimeContext`）⇒ `unavailable`。**一字节都不猜**：不可读的上下文绝不被读成「这个会话没有 Plan」。 |
| `src/main/session-persistence/coordinator.ts` | `readSessionRuntimeContext` 先问索引，`answered` 就用它，`unavailable` 仍读文档（与改动前**逐字相同**的那条路）。读取仍在同一个队列里（`enqueue`），只是「答案从哪来」变了。慢行读数新增 `source: 'index' \| 'document'` —— 否则「索引慢」会被读成「解析慢」，两者要修的地方完全不同。 |

`source` 是本单元的一半价值：分段读数（排队 / 读盘 / 克隆，见 `2026-10-22-runtime-context-read-phase-split.md`）
能说出「慢在哪一段」，但说不出「这段是谁的」；索引命中后读盘段本就该接近 0，缺了 `source` 反而会把
「索引读得慢」误判成「文档解析又退化了」。

## 三 门禁（全部实跑，读数取自最后一次改动之后）

在隔离工作树 `/private/tmp/ps-gate-2210`（`origin/main` `f2e79800` + 本单元 4 文件，`node_modules` 软链）上取：

| 环 | 读数 |
|---|---|
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0** |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0** |
| 域内 vitest（`src/main/session-persistence` + `session-plan` + `acp`） | **105 files / 1735 passed**，exit 0，141 s |
| `eslint --no-cache`（本笔 4 文件） | **0 problems** |
| `prettier --check`（本笔 4 文件） | 全部合风格 |

**tsc 抓到两条只有类型检查看得见的错（vitest 全绿时它们完全不可见）**，两条都在我自己新写的用例里：

1. 辅助函数把用例递进来的 spy 覆盖掉了 ⇒ `toHaveBeenCalledTimes(1)` 实际读的是一个**没被调用过的**新替身。
   症状不是红，而是「这条断言永远成立」。修法：把 spy 作为辅助函数的第二个参数传入并**原样保留**。
2. `first.revision = 99` —— 上下文按契约是 `readonly`，`TS2540`。修法：在用例里显式窄化成一个可写视图
   （`(first as { revision: number }).revision = 99`），断言意图不变：调用方无论怎么写，都不能污染下一次读到的索引条目。

## 四 两条变异各自只红该红的那条

| 变异 | 结果 |
|---|---|
| 把索引查找短路成恒 `unavailable`（等于回到改动前） | 4 条索引用例红，含「没有打开文档」那条 |
| sanitizer 拒绝时仍回 `answered` | 只红「索引里的上下文过不了 sanitizer 必须拒答」（`expected { status: 'answered' } to deeply equal { status: 'unavailable' }`） |

## 五 边界（不许读成更强）

1. **这是真数据读数 + 真代码路径，不是真窗口读数。** 本机内存闸门仍在（空闲物理页 ~120 MB、swap 13.1 G / 14.3 G），
   起 Electron 取证要重建 `build:e2e` 并跑真窗口，本轮不具备安全余量。窗口侧行为未取读数，**不声称**。
2. **没有换掉文档读那条路**：索引说 `unavailable` 时行为与改动前逐字相同，因此「答案变弱」不可能发生，
   但「答案变快」也只在索引命中的那 66/66 情形成立。
   **结构上的保证**（不是措辞）：摘要条目由 `summarizeSessionCatalogEntry` 产出，它只丢 `messages` /
   `conversationGraph` / `activities` / `activityGroups` 四个字段，其余走 `...rest` ⇒ 摘要里的 `runtimeContext` 是**整份**，
   不是裁剪过的投影；且读它时仍要过与文档读同一个 `sanitizeSessionRuntimeContext`。
3. **摘要件是产品自己在保存时写的**（`writeSessionSummary`，best-effort，失败不影响保存）。所以本单元不引入新的
   一致性风险：指纹不符时它退化成今天的路径。
4. 不占版本号：无新的用户可见能力，只是同一答案的取法。
5. **本单元不声称那 6 秒消失**。生产日志里这条通道是全应用**按总耗时排第一**的慢处理器
   （`logs/headless.out.log`，只读聚合，`ipc handler was slow` 一类、阈值 200 ms）：

   ```
   SLOW acp:get-plan-projection  n=580  median=6,303 ms  p95=121,617 ms  max=125,341 ms  sum=13,382,391 ms
   SLOW sessions:save-session    n=79   median=854 ms    p95=60,865 ms   max=125,589 ms  sum=708,964 ms
   SLOW notebook:state           n=68   median=8,629 ms  p95=25,253 ms   max=29,180 ms   sum=672,207 ms
   SLOW sessions:list-catalog    n=221  median=603 ms    p95=3,877 ms    max=7,861 ms    sum=262,259 ms
   ```

   `p95 = 121.6 s` 与 `sessions:save-session`、`send-prompt` 的量级同处一档 ⇒ 这条通道的耗时里**至少有一部分是排队**，
   而不是解析。本单元去掉的只是「解析」那一段；排队那一段由 `5c39a856` 的分段行去量，**下一单元按那个读数决定**。
   同一份聚合里还露出第二个候选（`notebook:state` 中位 8.6 s），留作下一轮的备选。
   分区取值的脚本在 `/tmp/summarise-slow-ipc.mjs`（不入仓）：这些记录是 Node 的**对象检视格式**（无引号键、单引号），
   按 JSON 解析会**读到 0 条**——我第一次就是这么读到空结果的。
