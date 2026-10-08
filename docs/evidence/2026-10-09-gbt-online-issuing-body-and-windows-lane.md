# 两件事：GB/T 7714 电子资源块此前丢掉「发布机构」；Windows 车道两条红的归属与一处收口（2026-10-09）

本轮的单元落在两处**不相交**的地方：批次 ①（中文医学场景）的**出处格式**那一半，以及当前 HEAD 上的
**Windows 车道两条红**。逐条读数即结论；未取到的部分在 §四 具名。

## 〇 开工核对（防重做）与并发执行体

- `HEAD == origin/main == cfdb8aff`（v1.92.0 发版提交）；分支 `main`。
- **工作树不干净，但那些路径不是本轮的**：`git status --short` = 9 个已修改 + 2 个未跟踪，全部属于**正在跑的
  桌面会话**——`src/main/connectors/reading-journal.ts` + `.test.ts`（新）、`connectors/service.ts`、
  `artifacts/provenance-repository.ts` + 两个测试、`ipc.ts`、`shared/artifact-provenance.ts`、
  `ArtifactProvenancePanel.render.test.tsx`、`reproducibility-*`；进程表里正有它的
  `vitest run src/main/artifacts/provenance-repository.test.ts src/main/connectors/reading-journal.test.ts`（02:22:51 起）。
  那批正是**批次 ② 差异化点 ③「产物 ↔ 读数引用链可遍历」**（`docs/evidence/2026-10-08-connector-reading-provenance-audit.md`
  §五 当时写着「未实施」），会话正在实现它 ⇒ 本轮**一个字节都不碰那些路径**，不 stash、不替它提交、不据它们
  声称任何读数（本轮提交只 `git add` 自己那 6 个路径）。
- 另一条防重做：批次 ① 的 ③（术语归一化）已由会话 `f2dac485` 交付、本执行器 `857b57cf` 补了连接器那一半，
  ② 由 IEDB 连接器 `903ee4fa` 承接 ⇒ 本轮只做 **④ 出处格式**与 **① 发布机构**这两半。

## 一 单元 A：GB/T 7714 的电子资源（[EB/OL]）块**结构性地丢掉「发布机构」**

**为什么算真缺口（不是措辞）**：批次 ① 差异化点 ① 要求「每条中文证据带**发布机构** + 年份 + 原文出处」，
差异化点 ④ 要求这份出处**按仓内既有 GB/T 7714 层**输出。而这条链上，发布机构在中途被丢掉：

| 事实 | 落点 |
| --- | --- |
| 记录里的 `publisher` **确实被带进**引用项 | `src/shared/citation/format.ts:59-74`（`citationItemFromReference` 的 `publisher: reference.publisher?.trim() \|\| undefined`） |
| 有 publisher 的记录走 **rich 分支**，不再走旧实现 | 同文件 `:171-173` `hasRichBibliographicFields()` 把 `publisher` 计入 |
| 而 rich 分支的电子资源格**从不输出 publisher** | `src/shared/citation/builtin-styles.ts` 的 `// Online / preprint / unknown:` 段（改前只出 `年` + `[引用日期]` + 路径） |
| `itemType` 对「有 url、无刊名」的记录判为 `web` ⇒ 正好命中该格 | 同文件 `:51-57` `inferCitationItemType()` |

⇒ 一条**中文网络证据**（例：发布机构「中华医学会」、年份 2021、原文路径）导出成 GB/T 7714 时，
**发布机构一个字符都不出现**——恰是差异化点 ① 要的那一条信息。

**同格此前零用例**：`grep -rn "EB/OL" src/**/*.test.*` 只命中 `src/shared/references-gbt.test.ts:51/67/92`，
而那三条**直接调旧 `formatGbt7714`**（`src/shared/references.ts:227`），根本不经过这个分支。

**改法（只开一个条件槽 + 让日期块与旧实现同形）**

| 记录形状 | 改前 | 改后 |
| --- | --- | --- |
| 有发布机构 + 年 + 引用日期 | `…[EB/OL]. 2021 [2026-10-09] . 路径` | `…[EB/OL]. 中华医学会, 2021[2026-10-09]. 路径` |
| 无发布机构 + 年 + 引用日期 | `…[EB/OL]. 2021 [2026-10-09] . 路径` | `…[EB/OL]. 2021[2026-10-09]. 路径` |
| 无发布机构（无 rich 字段） | 仍走旧实现（委派分支未动） | **逐字节不变** |

- 槽只在记录真带 publisher 时打开 ⇒ 没有发布机构的记录输出不变；**日期块与路径之间的间距**同一批
  收紧成旧实现本来的形状（`2021[2026-10-09]. 路径`）——旧 `formatGbt7714` 早就是这个形状，两条路
  对同一份记录**不该读起来不一样**（`src/shared/citation/format.ts:137-158` 的委派注释把「逐字节稳定」
  的范围明确限定为「没有新字段的记录」，本改动不越过它）。
- **不动的两处**：`BUILTIN_CITATION_STYLES` 里 GB/T 的 `uses` 不加 `publisher`（`uses` 驱动的是
  「这条记录缺 X」的上报；GB/T 的期刊条目本来就不需要 publisher，加了会让每条期刊记录都报缺它）；
  其他 8 个内置样式与导入 CSL 路径一字未改。

**用例（`src/shared/citation/format.test.ts` 新增 3 条，`describe('the GB/T [EB/OL] block carries the issuing body')`）**：
① 印出发布机构且在年之前；② 没有发布机构时该槽不出现（并 `not.toContain('中华医学会,')`）；
③ 只有发布机构（无年）与无日期（只有路径）两种收尾形状。
**变异验证（证明断言承重，不是凑数）**：把 `const issued = joinSegments([issuer, year], ', ')` 换回 `const issued = year`
⇒ `2 failed | 1 passed`（第三条按设计不依赖该槽，正确地仍绿）；恢复后 `21 passed`，`diff -q` 与备份**逐字节相同**。

**读数**：`vitest run src/shared/citation src/shared/references-gbt.test.ts` = **4 文件 / 53 passed**；
单跑 `format.test.ts` **21 passed**；`-t "issuing body"` 逐条 verbose 显示三条**真被执行**（不是被 skip 的绿）。

## 二 单元 B：当前 HEAD（发版提交 `cfdb8aff`）上 Windows 车道两条红 —— 归属 + 一处收口

**读数的归属先说清**：这一笔的 CI 判决属于**发版提交 `cfdb8aff`**，红的是
`Windows Full Test` run **37815532157**：`Windows full test (4/8)` 与 `(5/8)` 各 failure，其余 6 片 success；
同一份**代码**在上一提交 `7c1dd58c` 的 `Windows Full Test`（run 975）是 **success**
（`cfdb8aff` 只碰了 CHANGELOG / README / package.json 版本位）⇒ 这是**间歇**，不是本笔引入的回归。

### 2.1 片 5/8 —— `completion-gate.execute-control.integration` 的审批请求等超了 vitest 的默认窗

作业级注解逐字：

```
FAIL unit src/main/agents/completion-gate.execute-control.integration.test.ts > … > durably certifies
     the opencode provider projection for an ACP declined handoff
AssertionError: expected [] to have a length of 1 but got +0
Test Files  1 failed | 125 passed | 4 skipped (130)
```

- 失败点是该文件里等「审批请求被发出」的那条 `vi.waitFor(() => expect(emitted).toHaveLength(1))`
  （`createProductionExecuteControlHarness` 内）。**vitest 4 的 `vi.waitFor` 默认窗口是 1000 ms**
  （`node_modules/vitest/dist/chunks/test.DNmyFkvJ.js:3361` `const { interval = 50, timeout = 1e3 } = …`），
  本仓 `vitest.config.ts` 只设了 `testTimeout/hookTimeout: 60000`，没有设过 waitFor。
- 该文件**本仓自己就列在「默认并行下会超时」的 11 个文件里**（`docs/evidence/2026-09-18-default-parallelism-timeouts.md` §一），
  文件内注释也自述夹具地板「quiet 上 73-79 ms，拥塞下涨好几倍」；Windows 车道的分片又**本来就是串行**
  （`.github/workflows/windows-full-test.yml:73` `--maxWorkers=1`）⇒ 这是**冷启动 + runner 慢**把 1 s 窗口顶穿，
  不是争用。
- **收口（一处、只加窗不加断言）**：文件内新增单一来源常量 `APPROVAL_REQUEST_BUDGET_MS = 10_000`，
  两处 `vi.waitFor` 都带上它。按该文件自己的既有口径取「比测得地板高一个数量级」；**断言一字未改**
  （仍是 `toHaveLength(1)`），请求真的不来时照样失败，只是晚一点。
- **本机读数**：`vitest run src/main/agents/completion-gate.execute-control.integration.test.ts` = **22 passed（6.88 s）**。
- **这条必须由 Windows 车道验收**：下一轮按完整 SHA 读该提交的 `Windows Full Test`；**若同一处在 10 s 窗下仍红，
  读数就指向真缺陷**（Windows 特有的停顿），届时按作业级日志再定性，不得再加窗。

### 2.2 片 4/8 —— `project-files/repository.test.ts` 的 `beforeEach` 顶到 60 s（**本轮只归属、不改**）

作业级注解逐字：

```
Error: Hook timed out in 60000ms.
 ❯ src/main/project-files/repository.test.ts:42:3
```

- `:42` 就是该文件的 `beforeEach`：`mkdtemp` → `createProjectDbClient` → `ensureProjectSchema`
  （后者是 ~40 条裸 DDL，逐条带存在性检查），并且**每个用例都重来一遍**（该文件 39 个用例）。
- **本机成本读数（用于判断 60 s 是不是这个成本的放大）**：整文件 **39 passed（6.11 s，其中 tests 5.60 s）**
  ⇒ 每例的建目录 + 建客户端 + 建表约 **144 ms**。⇒ 60 s 不是这条成本的线性放大，是 runner 那次**停顿**。
- 一条**只记录、不作为修法**的事实：该文件的钩子写着显式 `60_000`，而车道传的是 `--hookTimeout=120000`
  ——显式值覆盖车道值，日志里响的正是 60 s。**加大超时是本仓明文否掉的收口方式**
  （`docs/plan-2026-10-08-windows-database-shard-triage.md` §三），所以不计入修法。
- **已并入那份工作单**（该文按主题扩写，不新建第二份）：加了本文件这一行、判定方向
  （共享 schema 初始化 / 降建表成本，**不是**调超时）、以及验收判据仍是「Windows 车道连续 N≥3 次绿」。
- **本机不能复现**：失败形状是 runner 停顿；且 shard 归属在本机复现不出 CI 的分片
  （本机 `vitest list --shard=4/8` 给出 149 个文件、目标文件不在其中 ⇒ 分片成员以 **CI 作业名**为准，
  不按本机 list 推断），所以**判决只能由 Windows 车道给**。

## 三 门禁

（见本轮汇报；读数取自打在本轮 6 个路径上的提交。）

## 四 未取 / 边界（具名）

1. **没有真机（窗口 / e2e）读数**：本轮改动是共享格式化层与一支集成测试，**都不带窗口入口**；
   而 `build:e2e` 会与正在跑 vitest 的桌面会话抢 `out/`，且本机 8 GB（开工时空闲物理页与 swap 未宽裕）
   ⇒ 本轮**不起 Electron**。GB/T 那一半的真机路径（文献库对话框「复制/导出 GB/T 7714 引文」）**未取**，
   具名立案给交互会话。
2. **批次 ① 差异化点 ① 的「中文源」那一半仍是挂账（不是本轮造成的）**：本机 2026-10-09 02:2x 复测
   四个候选源，全部只回 `text/html`、无机器可读契约 ⇒ 与 2026-10-08 的判定一致：

   | 源 | 读数（`curl -m 12`，2026-10-09） |
   | --- | --- |
   | `https://www.chictr.org.cn/` | http=200 bytes=34719 `text/html;charset=UTF-8` time=0.287 s |
   | `https://www.nmpa.gov.cn/` | http=200 bytes=54789 `text/html` time=0.439 s |
   | `https://www.cde.org.cn/` | http=200 bytes=86080 `text/html` time=0.241 s |
   | `https://www.cma.org.cn/` | http=200 bytes=89215 `text/html; charset=UTF-8` time=0.276 s |

   ⇒ 本仓红线（服务方 HTML 不是稳定契约）下**不写只读抓取器**；等有文档的接口再启。
3. **会话路径一个字节未动**（批次 ② ③ 的在制品），本轮提交只含自己的 6 个路径。
4. **未改任何 `.github/workflows/**`**（受保护）、未新增通道、未动 9 语字典、未改 `package.json`。
