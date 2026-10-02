# R2-U3 期刊指标筛选/统计面 —— 真机读数（2026-10-02 夜）

依据 `docs/plan-2026-10-02-R2-U3-journal-metrics-surface.md` 的验收口径：
**按分区与影响因子筛选；指标旁必须显示年份与来源；缺失显示「未知」，绝不显示 0 或空白。**
数据来源是**前一片自己的产物**（指标导入已真机过，提交 `041146dd`）——不是手写夹具，是走真实通道导进去的表。

## 一、方法（可复现）

```bash
mkdir -p /tmp/psq9-root /tmp/psq9 && printf '{"dataRoot": "/tmp/psq9/data"}\n' > /tmp/psq9-root/settings.json
PURESCIENCE_STORAGE_ROOT=/tmp/psq9-root PURESCIENCE_WEB_PORT=44210 npm run dev:headless
python3 probe9.py http://127.0.0.1:44210 /tmp/psq9-root/web-token import   # 走 references:import-journal-metrics
python3 probe9.py http://127.0.0.1:44210 /tmp/psq9-root/web-token read     # 走 references:list-journal-metrics
# 再把读回来的库交给**出厂的那份纯视图**算（不是另写一份逻辑）：
#   buildJournalMetricsOverview({ journals, claims, filter })
```

原始输出全文：`docs/evidence/2026-10-02-r2-u3-metrics-raw.txt`（导入 + 读取 + 四个视图逐字）；
探针与夹具：`…-metrics-probe.py`、`…-metrics-table.csv`。

## 二、造出的库（5 个期刊 / 8 条主张）

导入读数：`{"imported":8,"skipped":0,"journalsCreated":4}`；另**直接 seed 一个没有任何指标的期刊**
（`seed-no-metrics`）——那是真实库里本来就存在的状态（引用解析出了期刊，但没人导入过它的指标），也正是「未知」口径要覆盖的对象。

| 期刊 | 库里的名字 | 指标 |
| --- | --- | --- |
| Nature | `nature` | 影响因子 64.8 (2023) ＋ 62.1 (2022)；分区 一区 (2024) |
| Nature Communications | `nature communications` | 影响因子 16.6 (2023)；分区 二区 (2024)；录用率 `n/a` (2023) |
| 中华医学杂志 | `中华医学杂志` | 分区 一区 (2024)（无 ISSN，按精确规范化名登记） |
| Journal With A Non Numeric Factor | `journal with a non numeric factor` | 影响因子 **`n/a`** (2023)——值不是数字 |
| Journal With No Metrics | `journal with no metrics` | **一条都没有** |

## 三、四条视图读数（出厂纯函数在真库上算出）

### ① 不筛选（全部期刊）

```
counts {"total":5,"matched":5,"missingMetric":0,"valueNotNumeric":0,"notMatching":0}
  journal with no metrics  impact-factor=UNKNOWN  cas-partition=UNKNOWN  jcr-quartile=UNKNOWN  cas-top=UNKNOWN  acceptance-rate=UNKNOWN
  nature                   impact-factor=64.8(2023,Journal Citation Reports)  cas-partition=一区(2024,中科院文献情报中心)  …
  中华医学杂志              cas-partition=一区(2024,中科院文献情报中心)  impact-factor=UNKNOWN  …
```

- **无指标期刊显示「未知」**：五行全是 `UNKNOWN`，**没有一处是 0、没有一处是空白**（验收 ②）。
- **指标旁带年份与来源**：`64.8(2023,Journal Citation Reports)`（验收口径的字面要求）。
- 每一类都知道的指标都是**一列**，没人导入过就整列 `UNKNOWN`，不会因缺数据而消失。

### ② 按「一区」筛选

```
counts {"total":5,"matched":2,"missingMetric":2,"valueNotNumeric":0,"notMatching":1}
  nature          cas-partition=一区(2024,中科院文献情报中心)
  中华医学杂志     cas-partition=一区(2024,中科院文献情报中心)
```

**结果正确**（验收 ①）：一区的两本入选；`nature communications`（二区）计入 `notMatching`；没有任何分区主张的两本计入
`missingMetric`。`2+2+1+0 = 5 = total` —— 计数恒等式成立，所以「筛出来是空的」永远能追到原因。

### ③ 按影响因子 ≥ 10 筛选

```
counts {"total":5,"matched":2,"missingMetric":2,"valueNotNumeric":1,"notMatching":0}
  nature                 impact-factor=64.8(2023,…)
  nature communications  impact-factor=16.6(2023,…)
```

**值不是数字的那一本没有被当成 0**：`journal with a non numeric factor` 的影响因子是 `n/a`（写入期就记不到数字镜像），
筛选把它计入 `valueNotNumeric=1`，**既不参与比较、也不当 0**；没有影响因子主张的两本计入 `missingMetric=2`。

### ④ 限定年份 2022

```
counts {"total":5,"matched":5,"missingMetric":0,"valueNotNumeric":0,"notMatching":0}
  nature  impact-factor=62.1(2022,Journal Citation Reports)
```

**同一期刊的多年指标可以分辨**（验收 ③）：不限定年份时取**最新**年并标出 `2023`；限定 2022 时取到 `62.1` 并标出 `2022`。
（同一行里 `cas-partition` 变成 `UNKNOWN` 是对的：那张分区表只有 2024 年的主张，限定 2022 年时它不属于该年。）

## 四、隔离证明

| 位置 | 读数 |
| --- | --- |
| 真实配置根 `~/.purescience-project/purescience.db` | **无 `Journal` 表**（本次未写） |
| 真实数据根 `~/PureScience-DEV/.pdfs` | **18**（与开工前基线同） |
| 隔离库 `/tmp/psq9-root/purescience.db` | 本次全部工作在此（5 期刊 / 8 主张） |

## 五、没取到的（具名，不假装）

- ~~面板级 DOM 读数未取~~ **已取（2026-10-02 晚，接管该轮后补）**：`e2e/certification/journal-metrics-panel.spec.ts`
  在**真实 Electron 窗口**里走界面自己的入口（`[data-testid="workspace-references-toggle"]` → 对话里的 `Journal metrics` 按钮），
  用**应用自己的桥**播种（`api.references.importJournalMetrics`，不是戳数据库），随后读**渲染出来的 DOM**：
  ```
  [panel-reading] import: {"imported":4,"skipped":0,"journalsCreated":2, "outcomes":[…逐行 journalMatch:"by-issn"…]}
  [panel-reading] nature row: nature 0028-0836 Unknown 一区(2024 · 中科院文献情报中心) Unknown 64.8(2023 · Journal Citation Reports) Unknown
  [panel-reading] cells: ["nature","0028-0836","Unknown","一区(2024 · 中科院文献情报中心)","Unknown",
                          "64.8(2023 · Journal Citation Reports)","Unknown","nature communications",…]
  1 passed (9.1s)
  ```
  ⇒ **年份与来源在屏**、**缺失指标写成 `Unknown` 而不是 0 或空白**（cell 列表里没有裸 `0`，断言 `not.toContain('0')`）、
  两本刊是两行互不相同的数字。**仍未做的**：面板里**筛选控件**的 DOM 交互读数（分区/影响因子/年份三个控件的点击路径）——
  筛选逻辑此前只在纯函数层取证，控件交互**未取**，立案。
- **面板显示的是库里的规范化名**（`nature` 全小写、`中国科学 生命科学` 这种），因为 `Journal` 实体**只存 `normalizedName`**，
  没有显示名列。这是本片实测到的既有事实（读数里可见 `nature` 小写）；要显示原始大小写需要给实体加 `displayName`
  列（走既有 `addColumnIfMissing`），**未做**，立案。
- **导入界面未做**：面板只读；`references.importJournalMetrics` 仍以 RPC/无界面方式驱动，归档条目已如实写明理由。

## 六、门禁

- `npm run typecheck`（node ＋ web）：**0 error**。
- 定向 vitest：`src/shared` ＋ `src/main/references` ＋ `src/renderer/src/components/references` ＋ 六个契约文件 ＋ i18n 质量门禁 —— 全绿
  （含本片新增：纯视图 12 例、面板渲染 3 例、9 语种文案 key 对齐与 zh≠en）。
- `eslint`（改动文件）：**0 error**；`npm run gen:web-api-map` 幂等（生成物已同步）。
