# 诊断操作：相位时长与相位起点分开报（2026-11-22）

## 一 缺陷（从真机日志读出来的，不是从代码推出来的）

装机版 2.32.0 的 `~/Library/Logs/PureScience/main.log`，2026-11-21 三次 `update-download` 失败，逐字如下：

| 时刻 (UTC) | `durationMs` | `phases` | `totalPhaseMs` | `errorCategory` |
| --- | --- | --- | --- | --- |
| 09:00:51 | 2283340 | `transfer=1ms` | 1 | `network` |
| 10:02:52 | 3185058 | `transfer=2ms` | 2 | `connection-reset` |
| 10:18:33 | 634509 | `transfer=1ms` | 1 | `network` |

`transfer=1ms` 是**相位开始偏移**（进入 `transfer` 那一刻距操作开始 1ms），而该相位一直跑到操作结束，
实际耗时 2,283,339ms。三行放在一起看，字面意思是「38 分钟的下载只花了 1 毫秒在传输上」。

这不只是读者的误读，本仓自己的缺陷分诊已经踩过一次：上一单元（`8fd96b46`，更新下载停滞）的边界说明
写的就是「`phases` 的数字是相位开始偏移不是时长（`src/main/diagnostics/operation.ts`）」，而那段话本身
要先读一遍源码才能得出——日志自己不会说。

## 二 交付（`c7bc83a6` + `82c66c44`）

| 落点 | 内容 |
| --- | --- |
| `src/main/diagnostics/operation.ts` | 结束行不再有 `phases`。改成 **`phaseDurations`**（每个相位自己的时长：结束于下一个相位开始处，最后一个结束于操作结束处）+ **`phaseStartedAtMs`**（偏移）。两个名字不可能互相误读。 |
| 同上，`totalPhaseMs` | 从「最后一个相位的偏移」改成**各相位时长之和**（它覆盖的跨度）。首个相位**之前**的等待不计入——这条边界由用例钉住，因为它是唯一一个「和 ≠ durationMs」的合法情形。 |
| 同上，`snapshotPhases()` | 与完成行同单位（该相位到现在为止的时长），未完成的操作（应用启动）得到的数字与完成操作可直接比较。 |
| `src/main/index.ts` | 启动时间线那一行的键随之改名 `phaseDurations`（唯一消费方，`grep snapshotPhases` 全树只有这一处）。 |

旧日志里的 `phases` 字段不改写（那是当时量到的读数），只在 `docs/` 里被引用；新日志不再产生这个键。

## 三 读数（本机实跑）

| 环 | 读数 |
| --- | --- |
| `vitest run src/main/diagnostics/operation.test.ts` | **14 passed**（原 10 例 + 新增 4 例） |
| 变异 ①：时长退回偏移（`formatPhases` 两个分支取同一个值） | **7 failed**；恢复后 14 passed |
| 变异 ②：`totalPhaseMs` 退回「末相位偏移」 | **6 failed**；恢复后 14 passed |
| 隔离工作树 `/tmp/psr-phase`（`481df555`）`npm run typecheck:node` | **EXIT=0** |
| 同工作树 `npm run typecheck:web` | **EXIT=0** |
| `eslint --no-cache`（改动文件） | 0 error（首轮 1 条 prettier warning，已按仓内 prettier 折行 ⇒ `82c66c44`） |
| 全量 `vitest run --maxWorkers=4`（隔离工作树，`481df555`） | **1518 files passed / 31 skipped；19064 passed / 229 skipped；EXIT=0**（254s） |

新增四例各自守什么：

1. **真记录复现**：起点 1ms、结束 2,283,340ms ⇒ `phaseDurations: transfer=2283339ms`、`phaseStartedAtMs: transfer=1ms`、
   `totalPhaseMs: 2283339`。这一例就是上面那张表的第一行；改回旧行为它立刻红。
2. **交界处切开**：`transfer` 0→500、`verify` 500→600 ⇒ `transfer=500ms verify=100ms`，且 `totalPhaseMs === durationMs`。
3. **首相位之前的时间不算相位时间**：0→200 空转、`copy` 200→300 ⇒ `copy=100ms`、`totalPhaseMs=100`、`durationMs=300`。
4. **未完成操作的快照**：`load-bootstrap-modules=811ms external-mcp-started=89ms`（最后一个相位数到「此刻」）。

## 四 同轮修掉的两处主干红（都不是本单元引入的，但都在主干上）

1. **`19b1e325` 的用例半截**：`src/shared/citation/csl.test.ts:570` 把 `id: 'ref-1'` 传进
   `citationItemFromReference`，而 `CitationSourceRecord` 没有这个字段 ⇒ 两个 typecheck 同时 `TS2353`。
   该字段从头到尾没被读过 ⇒ 去掉（不往共享类型上补一个没人读的可选字段）。提交 `d667287d`。
2. **同一笔提交的实现半截**：两条用例（`2nd ed.` / `11th` / `21st`）依赖的 `ordinal` 词条只存在于**未提交**的
   `csl-locale-terms.ts` 里 ⇒ HEAD 上 vitest 红在 `csl.test.ts:861/867`，而两个 typecheck 全绿（缺的是运行期
   词条，不是类型）。把会话工作区里那 12 行词条一并入库（内容未改写），提交 `481df555`，用例转绿 47 passed。

两条合起来是一个形状：**用例与它的实现在同一批里被拆成了「已提交」与「留在工作区」两半**，而门禁只在一半上跑。
下次判「主干绿不绿」时，`typecheck` 与 `vitest` 必须都跑在**工作区干净的那个提交**上——只跑一个会漏掉另一半。

## 五 边界（具名）

1. **没有打包版读数**：这次改的是诊断行本身，本机没有能产生一次 `update-download` 的装机版运行（上一条路的
   真机复现要等下一次更新到底）。⇒ 下一次真机判据：装机版日志里 `operation failed` 行出现
   `phaseDurations: "transfer=…ms"`，且该数字与 `durationMs` 同数量级（而不是 1ms）。
2. **`operation phase` 那一条不变**：它记的是 `elapsedMs`（相位开始偏移），名字本身不骗人，所以没有改名——
   只有**并与 `durationMs` 并排**的完成行才会被读成时长。
3. **旧日志不改写**：`docs/evidence/2026-11-01-three-day-incident-review.md` 等处引用的 `phases=` 是当时的读数，
   保持原样；引用它们的结论（如启动时间线里 `ipc-handlers-registered=51016ms`）不受这次改名影响，因为那几行
   本来就是逐相位读的偏移，且相位是从 0 起算。
4. **`totalPhaseMs` 的口径变了**（从「末相位偏移」到「时长之和」）：首个相位不在 0 时两者不同，新口径更小、
   更诚实。历史证据档里的旧 `totalPhaseMs` 不要与新值直接比大小。
