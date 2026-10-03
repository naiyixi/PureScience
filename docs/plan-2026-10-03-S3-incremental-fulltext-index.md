# S3 增量全文索引 + 覆盖率诚实报告 —— 立项与切片（2026-10-03）

> 队列 `docs/plan-2026-10-03-next-queue-and-round-convention.md` §B.2。父排期定义见
> `docs/plan-2026-09-30-v1.77.0-search-models-skills.md:166-172`（目标/差距/差异化/四条真机断言）。
> 本文件只补**怎么切、怎么定**，不重复父排期已写清楚的部分。

## 1. 目标（一句话）

把「不做后台索引」变成**可增量、可续、覆盖与陈旧度可读**的索引：任何「没找到」都能回答
「这块内容在不在覆盖范围内、索引是不是旧了」。

## 2. 现有资产（都在树上，不是新建）

| 能力                                                                         | 位置                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 检索契约：作用域、有界扫描、`scanReport`/`scopeCoverage`/`notes`、排序、出处 | `src/shared/global-search.ts`                                            |
| 主进程检索：显式有界的扫描 + 命中退化时的 note                               | `src/main/search/global-search-service.ts`                               |
| 会话/标注/文件正文的扫描上限                                                 | `GLOBAL_SEARCH_MAX_SCANNED_SESSIONS/_ANNOTATIONS`、`handlers.ts` 里的 40 |
| 文件域的诚实提示（文件正文读不到时的 note）                                  | `global-search-service.ts:301-302` + i18n `en.ts:2822`                   |

**结论**：诚实报告这一半已经比对标强（对标要重启才启用全文检索）。缺的是**覆盖面**——没有索引，
每次搜索都只能现场扫有界的一小部分。

## 3. 拍板（实现前必须先定的四条，避免实现时反复）

1. **查询 = 索引 ∪ 现场有界扫描**。结果取并集、按现有排序规则合流 ⇒ **索引只会让命中变多**，
   父排期的判据④（索引前后是超集关系）成为结构性质，而不是靠测试运气。
2. **索引落在 `<dataRoot>/search-index/`**（与真实数据根同卷，便于取证与删除）。目录内含
   `manifest.json`（schemaVersion + 逐条指纹）+ `segments/*.jsonl` + `checkpoint.json`。
   删掉整个目录 ⇒ 覆盖读数为「空」，而**不是**「没有结果」（判据③）。
3. **增量靠指纹，不靠全量重扫**：每条的指纹 = `{size, mtimeMs}`（文件）或 `{updatedAt, messageCount}`
   （会话）。指纹未变则不重索引。
4. **预算与上限写进代码常量并如实上报**：每个 tick 最多 N 条或 Y ms（起步 50 条 / 250 ms），
   空闲时才跑（应用 ready 之后，不在启动路径上）；索引总量上限（起步 256 MB）——到顶时不静默丢，
   而是**具名**在覆盖读数里报「已达上限，未索引 x 条」。

## 4. 切片

- ✅ **S1（索引存储 + 计划）——已完成 `6f4d579b`**：`src/main/search/index-store.ts`：指纹计划（`planSearchIndex`）、
  原子落盘（`applySearchIndexPlan`，含「丢失项必须真的从索引消失」）、**磁盘权威的单调 checkpoint**、
  存储上限具名拒绝、删目录即「空覆盖」。
- ✅ **S2（查询接索引）——已完成 `a2f9217d`**：`global-search-service` 可选端口 `readIndex`，
  查询 = **索引 ∪ 现场有界扫描**（按 `(scope,id)` 去重 ⇒ 索引只让命中变多）；
  `GlobalSearchScopeCoverage` 扩为可读的 `indexed / pending / stale / capped`（无索引时字段缺席，
  本身就是诚实答案）。索引记录随之带上 `projectId/title/relativePath/timestamp`。
- ⬜ **S1b（填充与生产接线）——下一片，也是本版欠的那半**：`src/main/search/index-builder.ts` +
  在一个**主进程服务**里持有索引并**在启动路径之外**跑 tick（idle 起跑；每 tick 的条数与毫秒预算由
  S1b 引入两个具名常量，与 S1 已有的 `SEARCH_INDEX_MAX_BYTES`／`SEARCH_INDEX_MAX_ENTRY_CHARS` 同族），
  每 tick 落 checkpoint，然后把 `readIndex` 注进 `createGlobalSearchService`。
  四条实现前定死的口径：
  1. **只索引有界扫描受限的那几类作用域**（uploads/artifacts/literature 的正文）。`sessions/messages` 启动时
     已整体在内存里，索引它只会**双份存储**、不增加任何覆盖 ⇒ 不做（这条要写进代码注释，免得下轮"顺手补全"）。
  2. **指纹取自候选自身的 `size + mtimeMs`；取不到 mtime 的候选不索引**——宁可让它一直算 `pending`，
     也不写一个不可判的指纹（不可判的指纹会把"陈旧"变成谎话）。
  3. **读不到正文的候选要具名**（`unreadable`），不是静默跳过；上限到顶同样具名（S1 已有 `blocked.reason`）。
  4. **构建绝不进启动关键路径**（对标产品因此要重启，我们不学）；查询在索引还没填时照常工作，
     coverage 如实报 `indexed: 0`。
     ⚠️ S1b 会新增通道（状态读数 + 「立即索引」）⇒ **契约计数连锁要一起改**：
     `renderer-contract-catalog`(+test)、`application-command-composition`(+test)、
     `renderer-argument-shape-characterization`（写死的可调用面计数，A7/D1.3 已把它从 380 推到 382）、
     `http-server.test.ts` 的 localOnly 拒绝集、preload 清单。
- ⬜ **S3（界面读数）**：搜索面板显示「已索引 x / 待 x / 索引陈旧 y 分钟」+ 「立即索引」入口；
  **9 语种**（zh ≠ en）+ 渲染用例。
- ⬜ **S4（真机验收）**：隔离根起真实例，逐条取父排期的四条断言读数（新导入→未覆盖提示→索引后条数增加、
  中断续跑不回退、删索引目录→覆盖为空而非无结果、前后超集），落 `docs/evidence/`。

## 5. 明确不做（本片）

- **不做**模糊/词干/模型改写检索（契约已写明「字面匹配」是要保持的性质）。
- **不做**把索引塞进启动路径（对标就是这么做的，而且因此要重启；我们不学）。
- **不引入**新依赖、不做向量检索（那是另一条线）。
- 不动 `sessions/messages` 之外的既有作用域上限语义：上限是**诚实**的一部分，索引只是让覆盖变大。

## 6. 纪律

真实配置根只读；隔离实例写入一律落 `/tmp`；索引目录的删除/重建必须在隔离根里做并留读数；
收尾停进程、端口无监听、删临时目录、`git status` 干净。
