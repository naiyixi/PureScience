# 收割把文件留在远端：只说「超过了上限」，不给那个上限

> 单元：`left_on_remote` 条目补上它撞到的阈值（`limit_mb`），面板与 agent 载荷都能说出「超过 100 MB」而不是「超过上限」。
> 日期：2026-11-15。改动：`harvest-classifier.ts`（+类型/测试）、`harvest-engine.ts`（落库映射 + 测试）、
> `src/shared/compute.ts`（载荷类型）、`FeaturedOutputs.tsx` + `left-on-remote-reason.ts`（+测试）、九语字典、
> `resources/skills/remote-compute-ssh/SKILL.md`（agent 载荷说明）。

## 1 症状与缺口

一个 1,204 MB 的产物被留在远端时，面板上是这一行：

```
ssh:biowulf//scratch/reads.bam   1204 MB · Larger than the per-file download limit
```

读者拿到的两个事实是「它很大」和「有个上限」——**但没有上限是多少**，于是既不能判断差多少（要不要单独取回？），
也不知道该改哪个设置（`max_file_mb` 是每作业 `harvest_config` 里的字段，缺省 100）。同一份信息在
`attach_job().result()` 里同样缺：agent 只能读到 `reason: 'exceeds_max_file_mb'`，读不到阈值。

分类器**知道**这个数（它刚从 `max_file_mb`／`max_total_mb` 判过），只是没往条目里写。

## 2 根因与改动

| 位置                       | 改动                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harvest-classifier.ts`    | `LeftOnRemoteEntry` 增 `limit_mb?`；`exceeds_max_file_mb` 写 `maxFileMb`，`exceeds_max_total_mb` 写 `maxTotalMb`；`residency_remote` **不写**（没有阈值参与，凑一个数就是把「选择」说成「限制」） |
| `harvest-engine.ts`        | 落库映射带上 `limit_mb`（`undefined` 时**不写这个键**，旧行的形状保持原样）                                                                                                                       |
| `src/shared/compute.ts`    | `LeftOnRemoteEntry` 增 `limit_mb?`；`JobResult` / `JobSummary` 里两处手抄的内联形状**收敛到这一个类型**（原来同一形状抄了三份，加字段就会漏一份）                                                 |
| `left-on-remote-reason.ts` | 新增 `formatMegabytes`（MB 数 → 至多一位小数、无尾随 `.0`）；`leftOnRemoteReasonLabel(reason, t, limitMb?)` 在有阈值时用**带数字的句子**，没有时仍用原句                                          |
| `FeaturedOutputs.tsx`      | 文件大小也走同一个格式化器 ⇒ 行内两个数**同形**（`1204.5 MB` 与 `100 MB` 才可比）                                                                                                                 |
| 九语字典                   | 两条新键：`leftOnRemoteReasonFileLimitIs` / `leftOnRemoteReasonTotalLimitIs`（各带 `{limit}`）                                                                                                    |

**为什么保留「没有数字」那两句**：`limit_mb` 是这一版才有的字段，此前收割落库的行没有它。把它们显示成缺省 100/500
会把「当时生效的是默认值」当成事实——那个作业可能配的是 250。所以缺失就仍说「超过上限」，**不猜数字**。

## 3 读数

### 3.1 真机读数（真 SQLite 行 + 真 `harvestJob` + 产品自己的读路径）

探针（临时文件，跑完即删）：`createProjectDbClient` + `ensureProjectSchema` 在临时根建**真**库 → `ComputeJobRepository.create()`
落一行（`initialStatus: 'success'`）→ 调**真** `harvestJob`（只注入 ssh 列表与 scp，本机没有远端主机）→ 用**真**仓库回读
`left_on_remote` 列 → 走产品读路径 `readLeftOnRemote()`。

```
PROBE row created id=probe-job-1 harvested_at=undefined
PROBE column [{"uri":"ssh://biowulf/~/.purescience/jobs/probe-job-1/model.bin","size_mb":200,"reason":"exceeds_max_file_mb","limit_mb":100}]
PROBE state=enumerated entries=[{… ,"reason":"exceeds_max_file_mb","limit_mb":100}]
PROBE scp calls=0
PROBE2 entries=[{"uri":"ssh://biowulf/~/.purescience/jobs/probe-job-2/part2.result","size_mb":60,"reason":"exceeds_max_total_mb","limit_mb":100}]
```

第二行是**累计**那一路：作业自己配的 `max_total_mb: 100`（不是默认 500）被写在条目上 ⇒ 读出来的数字来自该作业的配置，
不是常量。`scp calls=0` 说明 200 MB 那一条确实没被下载（记录与行为一致，不是只补了一句文案）。

### 3.2 变异自证（探针真的会咬）

把 `harvest-engine` 的落库映射退回旧形状（不写 `limit_mb`），同一支探针：

```
PROBE column [{"uri":"ssh://biowulf/~/.purescience/jobs/probe-job-1/model.bin","size_mb":200,"reason":"exceeds_max_file_mb"}]
× writes limit_mb to the real job row
AssertionError: expected undefined to be 100
```

即：**旧形状就是这一行**（`{uri,size_mb,reason}`，与本单元之前的证据档一致），本单元确实改变了落库内容。

### 3.3 界面读数（渲染层）

`FeaturedOutputs.render.test.tsx` 新增一条：条目带 `limit_mb` 时，行内出现 `1204.5 MB` 与
`Larger than the 100 MB per-file download limit`、`Would take this job past its 500 MB download total`，且**不出现** `1204.4839`
（未格式化的浮点）。旧的「没有 limit_mb」用例保持在位 ⇒ 两态都钉住。

> 边界：本机空闲页仍不足以起 Electron 窗口（第 4 轮同一条闸门），本单元的界面证据是渲染层用例 + 纯函数用例，
> **没有真窗口截图**。文案与数字的最终装配点在 `FeaturedOutputs`（同一个 `<li>`，同一个格式化器），未另行取名。

## 4 门禁

| 环                                           | 读数                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| 定向 vitest（4 文件）                        | **4 files / 52 passed**                                     |
| `src/renderer/src/i18n`（九语门禁 + 质量门） | **4 files / 52 passed**                                     |
| `test/vitest-project-partition.test.ts`      | 通过（临时探针删掉后复跑；探针在树里时它**当场红**——见 §5） |
| 全量 vitest `--maxWorkers=4`                 | 见 §4.1                                                     |
| 双 typecheck（`--composite false`）          | node **0** / web **0**                                      |
| `eslint --no-cache`（本笔 11 个文件）        | 见 §4.1                                                     |
| `prettier --check`                           | 见 §4.1                                                     |

### 4.1 补跑（2026-11-15 13:0x，**在 `84489e56` 的隔离工作树上重取的读数**）

上一轮在写这份档的这三格之前被切断（`Operation interrupted: waiting for model response`），这三格一直空着，
而计划档里那组数字取自**改动的不同时刻** ⇒ 按「门禁数字必须来自最后一次改动之后的那一遍」重跑一遍，
下面这一组作用在**这个提交本身**（`git worktree add /tmp/ps-gate-84489 84489e56` + `node_modules` 软链）：

| 环                                                                        | 读数（本轮实跑）                                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 全量 vitest `--maxWorkers=4`                                              | **1477 files passed / 31 skipped（1508）**；**18507 passed / 228 skipped（18735）**；**`VITEST EXIT=0`**，298 s                        |
| `npx eslint --no-cache`（本笔 18 个有代码的路径：9 源/测试 + 9 语言字典） | **exit 0**，输出为空（0 error / 0 warning）                                                                                            |
| `npx prettier --check`（18 个代码路径 + 证据档 + `SKILL.md`）             | **exit 0** — `All matched files use Prettier code style!`（计划档除外：它在 `563870f1` 上就已是未格式化态，属既有、不重排 19k 行台账） |
| `tsc --noEmit -p tsconfig.node.json --composite false`                    | **exit 0**，`error TS` **0** 处                                                                                                        |
| `tsc --noEmit -p tsconfig.web.json --composite false`                     | **exit 0**，`error TS` **0** 处                                                                                                        |

**与计划档那组数字的差**（如实记）：计划档 §三百三十六 §三 写的是 1479 文件 / 18533 例，本轮是 1477 / 18507。
差在文件数 −2、用例 −26 —— 那一组取自共享工作树（同一时刻还躺着别人的在制测试文件），本组取自**只含这个提交**
的隔离工作树 ⇒ 按纪律以**本组**为准，计划档那组不再作为本单元的证据。

## 5 边界与坑

1. **只补数字，不改阈值行为**：分类规则（>max_file_mb、累计 >max_total_mb、顺序、`residency_remote` 不下载）一个字没改。
2. **旧行不补历史数字**：`limit_mb` 缺失就是缺失，回填只能靠重算当时的 `harvest_config`，而那份配置可能已被改过。
3. **临时探针要立刻删**：它用真 SQLite，落在 `src/main/compute/` 会被 `vitest-project-partition` 的
   「real-SQLite 套件不得进并行池」守卫当场拦下（实测：全量那一轮就红在它身上，点名文件是我自己的探针）。
   这是守卫按设计工作，不是产品缺陷——删掉探针后该用例复跑通过。
4. **累计那一路的句子不写「已复制多少」**：`used_mb` 需要额外字段与九语文案，而读者从 `超出 {limit} MB 的下载总量`
   加上本文件自身大小已能推出差多少；少一个字段就少一处能漂移的账。
