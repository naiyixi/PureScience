# 工作单：Windows `database` 分片那条红的定性（给 Windows 车道的复跑规程）

> 建立于 2026-10-08（会话）。本条**不是**「某条用例坏了」——它是**同一份代码时绿时红、且换用例**，
> 只在 Windows 上、且带文件锁味道。本单把它变成可执行的复跑步骤，**结果必须由 Windows 车道给出**，
> 本机（macOS）拿到的东西只能用来排除假设。

## 一、已有读数（不要重做）

| 读数 | 依据 |
| --- | --- |
| 该分片**本来就是串行**的 | `.github/workflows/windows-full-test.yml:73` — `npm test -- --shard=<n>/8 --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000 …` |
| 仓里的口径：**能顶到天花板是一条待查的发现，不是要调小的数字** | 同文件第 70–73 行注释逐字 |
| 同一份代码：`c15bbc1c` **success** / `db06590c` failure（`provenance-migration-validation` 30s + `EBUSY: resource busy or locked, unlink '…purescience.db'`）/ `e3b1da0f` failure（**换成** `reviewer/repository` 的 **120s** 超时） | 各提交的 `Windows Full Test` run + 作业级注解 |
| 超时那条文件在 macOS 上 **27 passed / 3.13s** | 本机实测（`src/main/reviewer/repository.test.ts`） |
| `commitFindingDispositions` 是**单个 `$transaction`**，**没有重试循环/退避** | `src/main/reviewer/repository.ts:721` |

⇒ 已排除：并行争用（本来就是 1 worker）、重试风暴、以及「某条断言写错」。

## 二、复跑规程（在 Windows 上做；每步一条命令，读数照抄进证据档）

前置：需要一台 Windows 能跑本仓测试的环境（最省的是派一次 `windows-full-test.yml`，见 §四）。

1. **单文件复跑那两条**（分片内串行，但复跑能区分「自己慢」与「被邻居拖慢」）：
   ```
   npm test -- --run src/main/reviewer/repository.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
   npm test -- --run src/main/storage/provenance-migration-validation.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
   ```
   - **两条各自绿** ⇒ 真因是**分片内的互相影响**（下一步 2）。**任一仍红** ⇒ 它是自身慢/挂，进第 3 步。
2. **看邻居**：把该分片（`--shard=<n>/8`）里排在这两条**之前**的文件名列出来，逐个与它们一起复跑（先前的那个 + 目标那个）：
   ```
   npm test -- --run <先前的文件> src/main/reviewer/repository.test.ts --maxWorkers=1 --testTimeout=120000
   ```
   - 若**成对复跑就红** ⇒ 前一条留下了未释放的 SQLite 句柄/临时目录（本仓已知族：`.db` 句柄、`chmod`/只读前缀、临时根清理）。
     修法方向：让**留下者**真正释放（`$disconnect` 到位、临时目录用 `fs.rmSync(..., { maxRetries, retryDelay })`），
     **不是**给受害者加超时。
3. **单文件仍红时，量它慢在哪**（不许靠加大超时收口）：
   ```
   npx cross-env DEBUG='prisma:*' npm test -- --run <该文件> --maxWorkers=1 --testTimeout=120000
   ```
   - 关键读数：`ensureProjectSchema(client)`（Prisma 建表）在自己的走时里占多少；是否出现**锁等待**（Prisma/SQLite 的 `database is locked`）。
   - 建表本身就是瓶颈 ⇒ 方向是**共享 schema 初始化**或把该文件的建表成本降下来（不是调超时）。
4. **两条都要带回**：`<文件名> | 单跑读数 | 成对读数 | 与哪个邻居成对 | 原始报错逐字`。

## 三、红线（本仓明文）

- **不许**用加大 `--testTimeout` / `--hookTimeout` 收这类红（技能与仓内注释双重否掉）。
- **不许**跳过文件、不许把断言改弱、不许把用例搬走当成修好（搬走只能作为**定性之后的**分区调整，且要写明为什么改分区能治它）。
- 取到的读数写进 **v1.89.0 的证据档**（`docs/evidence/`）+ 排期档该行；**只有 Windows 车道的判决算数**，本机读数只用于排除假设。
- 若真因落在产品侧（事务的锁等待/释放顺序），**修法要配一条能在 Windows 复现的探针**，否则「修好了」无法证伪。

## 四、怎么拿到 Windows 车道的判决（本机做不了）

- **最省**：`gh workflow run windows-full-test.yml --ref main`（按需指派；注意它与推送运行**共享同一 concurrency group**，别在同一 ref 上叠运行）。
- 或等下一次推送自然触发。判读用**完整 40 位 SHA** 查 `Windows Full Test` 的作业级注解；
  `--shard` 作业名会告诉你红在第几分片（如 `Windows full test (4/8)`）。
- 红了先看**失败文件是否本笔碰过**：本笔只改分区/测试时，若红在**别的文件**且形态是超时/`EBUSY`，按本单继续定性，不要改产品迁就。

## 五、验收

一条读数即可结案：**「在 Windows 上，`database` 分片连续 N 次复跑全绿，且这 N 次里目标两条与它前后的邻居都在同一分片」**，
或**「定位到具体机制 + 修法 + 一条能在 Windows 复现的探针，且修后该分片连续 N 次绿」**。N ≥ 3（本仓对负载敏感类用例的口径）。

## 六、2026-10-09 追加：同一族里出现**第二支文件**，且红的是**另一片**（`4/8`）

发版提交 `cfdb8aff` 的 `Windows Full Test` run **37815532157** 两片红（`4/8` + `5/8`），
而同一份代码在上一提交 `7c1dd58c` 的 run 975 是 **success**（该发版提交只改 CHANGELOG/README/`package.json` 版本位）
⇒ 仍然是「同一份代码时绿时红」。**这条工作单的适用范围比文件名写的宽**：它治的是「Windows 分片里
建库/建表/落盘类用例顶到天花板」这一族，不限于 `database` 那一片。

### 6.1 已经收口的一半（片 `5/8`）

失败在 `src/main/agents/completion-gate.execute-control.integration.test.ts` 等「审批请求被发出」的
`vi.waitFor`：**vitest 4 的默认窗是 1000 ms**（`node_modules/vitest/dist/chunks/test.DNmyFkvJ.js:3361`），
本仓 `vitest.config.ts` 从未设过它。收法是文件内单一来源常量 `APPROVAL_REQUEST_BUDGET_MS = 10_000`
+ 两处 `vi.waitFor` 带上它，**断言一字未改**。⚠️ **这条必须由 Windows 车道验收**：若同一处在 10 s 窗下仍红，
读数指向真缺陷（Windows 特有停顿），届时按作业级日志再定性，**不得再加窗**。

### 6.2 仍然待定的一支（片 `4/8`，本轮只归属、不改）

```
Error: Hook timed out in 60000ms.
 ❯ src/main/project-files/repository.test.ts:42:3
```

- `:42` = 该文件的 `beforeEach`（`mkdtemp` → `createProjectDbClient` → `ensureProjectSchema` ≈ 40 条裸 DDL，
  逐条存在性检查），**每个用例重来一遍**（39 例）。
- **本机成本读数**：整文件 **39 passed / 6.11 s（tests 5.60 s）** ⇒ 每例约 **144 ms** ⇒ 60 s 不是这条成本的
  线性放大，是 runner 那次**停顿**（同族的老读数也支持「自身慢」这条被排除）。
- **一条只记录、不作修法的事实**：该文件钩子写的是显式 `60_000`，覆盖车道传的 `--hookTimeout=120000`
  ——日志里响的是 60 s。**加大超时是本仓明文否掉的收口方式**（本文 §三），所以不计入修法。
- **下一步形状（沿用本单 §二 的规程，不许用加大超时/跳过文件收口）**：先按本文 §二 第 1–3 步在 Windows 上
  单跑/成对复跑这支文件，量 `ensureProjectSchema` 在它自己的走时里占多少、是否出现锁等待；方向仍是
  **共享 schema 初始化 / 降建表成本**。
- **本机不能给出分片成员**：`vitest list --shard=4/8` 在本机给出 149 个文件、目标文件**不在其中**
  ⇒ 分片成员以 **CI 作业名**为准，不要按本机 list 推断邻居。判决仍只能由 Windows 车道给，N ≥ 3。


## 七、2026-10-09 结案：两支文件的 Windows 判据都达到 **N ≥ 3**（实取 **N=4**）

本单 §五 的验收判据是「该分片连续 N 次全绿，N ≥ 3」。自片 `5/8` 的修法落树（`395d3e17`）与片 `4/8` 的归属
（`cfdb8aff` 之后）起，`Windows Full Test` 已连续 **4 次**全绿，且 **8/8 分片全部 success**——读数按完整 40 位 SHA 取：

| 提交（完整 40 位） | Windows run | 分片判决 |
| --- | --- | --- |
| `395d3e17c527c03270612b1ea6ad76481c6f0b61` | 37825846029 | 8/8 success（含 `4/8`、`5/8`） |
| `9a3bfef7fcc96ef29b435b655e3e8d35c7da2e88` | 37866542307 | 8/8 success（含 `4/8`、`5/8`） |
| `e2590ab065a2f21c7e015e66bd711c645c03d665` | 37867733052 | 8/8 success（含 `4/8`、`5/8`） |
| `ba65d723c8ecedb26f77d183a2019e988b8a1f0e` | 37882462504 | 8/8 success（含 `4/8`、`5/8`） |

- **片 `5/8`（已修）**：`src/main/agents/completion-gate.execute-control.integration.test.ts` 的
  `APPROVAL_REQUEST_BUDGET_MS = 10_000` 生效后 **4 次未复发**；期间那支 `vi.waitFor` 断言一字未改
  ⇒ 原文的「窗口被冷启动/runner 慢顶穿」判断成立，**不是** Windows 特有的真缺陷。
- **片 `4/8`（只归属、未改代码）**：`src/main/project-files/repository.test.ts` 的钩子停顿在**同一批 4 次运行里未复发**。
  按本单 §六.2，它的机制（每例重建 ~40 条 DDL 的建表成本 / 锁等待）**本机复现不出**，
  所以这里的结案口径是**「连续 4 次 Windows 读数不复发」**，而不是「已定位并修好」。
  **备选修法方向保留**（共享 schema 初始化 / 降建表成本，**不是**调超时）；**若再次复发**，
  直接从本单 §二 第 1–3 步在 Windows 上单跑/成对复跑开始，不要从头调研。
- **本单的一条纪律仍然有效**：取分片成员以 **CI 作业名**为准（本机 `vitest list --shard=4/8` 给 149 个文件、
  目标文件不在其中，见 §六.2）。
