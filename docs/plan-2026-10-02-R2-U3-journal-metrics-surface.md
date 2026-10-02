# R2-U3 执行清单：期刊指标的筛选/统计面（下一片；只写计划，未动代码）

> 依据 `docs/plan-2026-10-01-R2-journal-entity.md` §U3 的验收口径：
> **按分区与影响因子筛选；指标旁必须显示年份与来源；缺失显示「未知」，绝不显示 0 或空白**。
> 前提已满足：指标导入片已真机过（提交 `041146dd`，读数 `docs/evidence/2026-10-02-r2-journal-metric-import.md`）
> ⇒ 库里**真有**指标行，此时做显示面才不会一直显示「未知」（那会像功能有 bug 而不是没数据）。

## 0. 现状（读自当前 HEAD，不是猜）

| 事实 | 位置 |
| --- | --- |
| `JournalRepository` **没有期刊级读路径**（只有 `listMetrics(journalId)` 单刊） | `src/main/references/journal-repository.ts:221`；`upsertBy*`/`resolveJournal`/`appendMetric`/`findMetric` 之外无 list |
| 期刊是**存储根级**实体，不挂项目 | `ipc.ts:127-132` 的 `createDefaultJournalRepository`；`importJournalMetrics` 签名**不带** projectId（`ipc.ts:68`） |
| 引文库界面是「一个对话框 + 若干 section 条件渲染」，不是多 tab | `src/renderer/src/components/references/ReferencesLibraryDialog.tsx:919-1263`（单 `<section>`）；筛选面按 `showScreening && selectedCollectionId !== null` 条件挂载（`:1111-1122`） |
| 切换开关的既有形状 | `showScreening` 状态 `:176`、按钮 `aria-pressed` `:930-932`、切换时重置 `:297` |
| i18n 键前缀惯例 | `references.screening.*`（`i18n/zh.ts`）；9 个语言文件（de/en/es/fr/ja/ko/ru/zh/zh-Hant）+ `i18n/pending-translations/{de,es,fr,ja,ko,ru,zh-Hant}.pending.json` |
| 契约连锁（加一条通道会动到的计数测试） | `application-command-composition.test.ts`（342/340/221）、`renderer-contract-catalog.test.ts`（453）、`renderer-surface-inventory.test.ts`、`preload/index.test.ts`（core 223 / requests 185）、`renderer-argument-shape-characterization.test.ts`、`screening-ipc.test.ts` |
| 归档决策必须清出 | `src/shared/entry-layer-archived-surfaces.ts:98` 一条（`references.importJournalMetrics`）——注释已写明「U3 接上后该条必须在 honesty 测试里被清出」 |
| 生成物 | `npm run gen:web-api-map`（`src/shared/web-api-map.generated.ts`，须幂等） |

## 1. 设计决策（先把会漂移的口径钉死）

1. **过滤放在一处纯函数**：`src/shared/journal-metrics-overview.ts`。仓储只做**两次查询取全量行**（`journal.findMany` ＋
   `journalMetric.findMany({ where: { journalId: { in } } })`，**不做 N+1**），把它交给纯函数算成视图。
   理由：这份视图要在界面里反复改筛选条件即时重算，走一次往返就会闪烁；纯函数也才可能被逐条真机读数核对。
   **边界**：期刊量级变大（>约 2000 行）时把同样的契约下沉到 SQL —— 契约（输入行、输出视图）先钉死在 shared，搬家不改语义。
2. **一行＝一个期刊**；每类指标一格：`{ value, year, source }` 或 `null`。多值类指标（影响因子逐年、分区逐年）按**最大年份**取，
   年份相同的并存时按 `fetchedAt` 取最新，并在视图里**标明所用年份**（不允许「悄悄挑一个」）。
3. **「未知」是显式值，不是缺省字体颜色**：某类指标无行 ⇒ 视图给 `'unknown'` 标记，面板渲染 `t('references.journalMetrics.unknown')`。
   **绝不给 0、绝不给空白**。仓储层已保证「无年份/无来源的数字进不了库」，但显示层仍按缺失处理（防御：库里可能有历史行）。
4. **数字筛选的诚实**：`value` 是 TEXT（`"64.8"`）。严格解析（`parseMetricNumber`）：仅接受十进制字面量；
   `"n/a"`/`"Q1"`/`"二区"` 一律**不可比** ⇒ 该期刊在数字筛选下归入具名原因 `value-not-numeric` 的排除计数，
   **绝不当 0、绝不静默丢弃**。面板必须显示「因值不可比被排除 N 个」，否则「筛出来是空的」会被误读成「没有这本期刊」。
5. **计数必须对账**：`matched + excluded(value-not-numeric) + missing-metric = 期刊总数`，面板把这三项都显示出来。
6. **界面挂在引文库对话框**（期刊是库级实体，不是某个 collection 的）：新增 `showJournalMetrics` 开关（照 `showScreening` 的形状：
   状态＋`aria-pressed` 按钮＋切换时复位），条件渲染新组件 `JournalMetricsPanel`。
7. **读数通道**：新增应用命令 `references:list-journal-metrics`（无 projectId，与导入同口径），返回 `{ journals, metrics }` 原始行；
   渲染侧用 §1 的纯函数算视图 ⇒ 同一份逻辑既被单测也**在真机上被 RPC 读数核对**。
8. **不做的**：不做模糊匹配、不做自动合并（那是 U4，且只做**用户显式合并**）；不改既有 `Reference.venue` 显示路径。

## 2. 编辑清单（按序，每步都可单独绿）

1. `src/shared/journal-metrics-overview.ts`（新，纯）
   - `selectLatestPerKind(metrics)`：按 `kind` 取最大 `year`；并列取 `fetchedAt` 最大；返回 `{ kind → {value, year, source, fetchedAt} }`。
   - `parseMetricNumber(value)`：严格十进制；不可比 ⇒ `null`（不是 0）。
   - `buildJournalMetricsOverview(journals, metrics, filter)` ⇒ `{ rows, counts: { total, matched, excludedValueNotNumeric, missingMetric } }`。
   - `JournalMetricsFilter = { partition?: string; minImpactFactor?: number; maxImpactFactor?: number; year?: number }`。
2. `src/main/references/journal-repository.ts`：`listJournalsWithMetrics()`（两次查询，无 N+1；`orderBy: normalizedName` 保证确定性）。
3. `src/main/references/ipc.ts`：handler 类型 ＋ 实现（复用 `createDefaultJournalRepository`）＋ `ipcMainHandle` 注册。
4. `src/main/references/application-commands.ts`：命令对象 ＋ group ＋ handler map（`references:list-journal-metrics`）。
5. `src/preload/index.ts` ＋ `src/preload/renderer-api.d.ts`：桥与类型。
6. `src/shared/renderer-contract-catalog.ts`（`:281` 一区）＋ 跑 `npm run gen:web-api-map`。
7. **契约计数连锁全修**：上面表格里六个测试文件的计数（composition / catalog / inventory / preload / argument-shape / screening-ipc）。
8. `src/shared/entry-layer-archived-surfaces.ts`：**删掉** `references.importJournalMetrics` 那条归档决策（它之所以能归档，正是因为显示面在本片；诚实测试必须随之绿）。
9. 新组件 `src/renderer/src/components/references/JournalMetricsPanel.tsx`：筛选控件（分区下拉/影响因子下限/年份）＋ 表格
   （期刊名、每类指标 `值 (年份 · 来源)`、「未知」）＋ 对账计数行 ＋ 空结果时的具名解释。
10. `ReferencesLibraryDialog.tsx`：`showJournalMetrics` 状态（照 `:176`）＋ 开关（照 `:930-932`，含 `aria-pressed` 与 9 语种标签）＋ 挂载（照 `:1111`）。
11. i18n：`references.journalMetrics.*`（标题、未知、分区、影响因子、年份、来源、计数行、空结果解释，含复数/占位符）
    在 **9 个语言文件**实译（zh 值不得等于 en 值），`pending-translations/*.pending.json` 一并处理；跑 `translation-quality.test.ts`。
12. 测试：shared 纯函数（含 `value-not-numeric`、多值取最新 + 并列取 fetchedAt、计数对账恒等式）、组件渲染用例（未知 vs 0、年份与来源可见）、
    ipc 契约用例。

## 3. 验收（真机/真文件，逐条；单测不算）

| 判据 | 怎么取 |
| --- | --- |
| **按「一区」筛选结果正确** | 隔离实例里先用**导入命令**造数据（分区 `一区`/`二区` 各若干、影响因子数值与不可比值各若干），再走真实 RPC 读回视图；断言筛选结果集逐个名字正确 |
| **无指标期刊显示「未知」** | 造一个只有名字、没有任何指标行的期刊 ⇒ 面板与视图均为「未知」，**且不为 0、不为空串** |
| **同一期刊多年指标能区分年份** | 同刊写两年影响因子 ⇒ 视图取最大年份并**显示该年份**；展开/另一年份读数可分辨 |
| 数字不可比不得当 0 | 造 `value='n/a'`（须有 year＋source 才能入库）⇒ 数字筛选中归入 `value-not-numeric` 排除计数，**且计数行显示出来** |
| 计数对账 | `matched + excluded + missing = total`，真机读数逐项相等 |
| **面板级读数**（不是只看服务） | 照 R4-U4 的先例加一条认证 spec（真窗口、走界面自己的入口、读渲染出来的 DOM）：隔离实例 ＋ 真库，读出「一区」筛选后的行、「未知」文本、年份与来源 |
| 无空壳 | 面板必须有真交互闭环（筛选控件改变结果、空结果给具名解释），**禁**只读死的占位表 |

隔离与清理口径同上一片：`PURESCIENCE_STORAGE_ROOT=/tmp/<新>` ＋ `settings.json` 里绝对 `dataRoot` ＋ 独立 `PURESCIENCE_WEB_PORT`；
收尾停进程、确认端口无监听、删临时目录、`git status` 干净。真实根只读。

## 4. 明确不做（本片）

- **U4 别名与显式合并**：本片不做；近似名不自动吞并。
- **不把缺失指标显示成 0 或空白**（本片的核心口径）。
- **不引入分页/虚拟滚动**（期刊量级未到；到了再做，且 §1.1 的契约不变）。
- **不改既有引文列表对 `venue` 文本的显示**（未解析到期刊的引用仍按文本显示，不回填）。
