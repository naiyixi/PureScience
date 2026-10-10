# 中文「研究方法/设计」词条：英文侧逐条取自 MeSH（2026-10-10）

批次 ① 的中文表是**医学向**的（药名/适应证/机构名/期刊名），因此**研究方法类**的中文词（队列研究、
随机对照试验、荟萃分析……）此前一律落进"未映射"：在 PubMed/arXiv 上具名拒答，在 OpenAlex 上按原样搜。
而中文临床问题**通常就是"设计词 + 主题"**（「随机对照试验 阿司匹林」），设计那一半被拒等于问题问不全。

本档是这批词条的**词源**，也是与 `src/shared/chinese-terms.ts` **逐条互核**的对象（读源测试会比对，
任一边漂了测试就红）。

## 一、口径（为什么这么做）

**错映射比缺映射更糟**：它不会报错，只会**悄悄把问题换成另一个问题**。所以本批的**英文侧不是我在这里翻的**，
而是**从 MeSH 的查询服务读出来的**：

```
GET https://id.nlm.nih.gov/mesh/lookup/descriptor?label=<english>&match=exact&limit=1
→ {"resource": "http://id.nlm.nih.gov/mesh/D016449", ...}
```

每行记下**它当时返回的描述符号**（`mesh:D…`），任何人都能拿这个号去 `https://id.nlm.nih.gov/mesh/D016449`
核对英文侧到底是不是那个词。取数时间：**2026-10-10**。

**中文侧要如实说明**：中文词形不是 MeSH 给的（MeSH 的描述符是英文的），它是**中文医学文献里通行的写法**。
这一半是**本表的**，不是权威机构的；所以每行的 `source` **只承诺英文侧**。变体也只收**指同一件事**的
异写 —— 例：`基因表达` 是 gene expression、不是 gene expression **profiling**，因此**刻意不做** `基因表达谱` 的变体。

## 二、逐条（表 ↔ 本档互核）

| 中文（canonical） | english                          | source          |
| ----------------- | -------------------------------- | --------------- |
| 荟萃分析          | meta-analysis                    | mesh:D017418    |
| 随机对照试验      | randomized controlled trial      | mesh:D016449    |
| 队列研究          | cohort studies                   | mesh:D015331    |
| 病例对照研究      | case-control studies             | mesh:D016022    |
| 横断面研究        | cross-sectional studies          | mesh:D003430    |
| 系统评价          | systematic review                | mesh:D000078182 |
| 前瞻性研究        | prospective studies              | mesh:D011446    |
| 回顾性研究        | retrospective studies            | mesh:D012189    |
| 随访研究          | follow-up studies                | mesh:D005500    |
| 纵向研究          | longitudinal studies             | mesh:D008137    |
| 双盲法            | double-blind method              | mesh:D004311    |
| 生存分析          | survival analysis                | mesh:D016019    |
| 预后              | prognosis                        | mesh:D011379    |
| 危险因素          | risk factors                     | mesh:D012307    |
| 比值比            | odds ratio                       | mesh:D016017    |
| 置信区间          | confidence intervals             | mesh:D016001    |
| 动物模型          | disease models, animal           | mesh:D004195    |
| 全基因组关联研究  | genome-wide association study    | mesh:D055106    |
| 免疫组织化学      | immunohistochemistry             | mesh:D007150    |
| 聚合酶链反应      | polymerase chain reaction        | mesh:D016133    |
| 机器学习          | machine learning                 | mesh:D000069550 |
| 深度学习          | deep learning                    | mesh:D000077321 |
| 列线图            | nomograms                        | mesh:D049451    |
| 孟德尔随机化      | mendelian randomization analysis | mesh:D057182    |
| 倾向性评分        | propensity score                 | mesh:D057216    |
| 中介分析          | mediation analysis               | mesh:D000081983 |
| 转录组            | transcriptome                    | mesh:D059467    |
| 基因表达谱        | gene expression profiling        | mesh:D020869    |
| 单细胞分析        | single-cell analysis             | mesh:D059010    |
| 蛋白质组学        | proteomics                       | mesh:D040901    |

## 三、真机读数（经应用自己的连接器，一次性探针，跑完即删）

| 连接器 | 请求                    | 实际发出                              | 结果        |
| ------ | ----------------------- | ------------------------------------- | ----------- |
| PubMed | `随机对照试验 阿司匹林` | `randomized controlled trial aspirin` | **9,072**   |
| arXiv  | `all:随机对照试验`      | `all:randomized controlled trial`     | **401,679** |

两边的 `zh_terms` 都逐条回带了 `kind: "method"` 与 `english`。**改前**这两个词都不在表里，
因此整句在各连接器上**具名拒答、一个请求都不发**（不是"搜了但零结果"）—— 也就是说这次变化是
**从"问不出口"到"问得出口且真拿到了结果"**，不是把零变成非零。

## 四、覆盖面与下一步

- 这 30 条只覆盖**最常见**的设计/统计/组学词；还有大量未收（如「真实世界研究」「影像组学」「单臂试验」）。
  收词的门槛是**英文侧能在 MeSH 里定位到**（或换一个同样可核对的权威），不够格的不进表。
- 未收 ≠ 被当成阴性：未映射的中文在各连接器上**按各自政策**处理（arXiv/PubMed 具名拒答；OpenAlex 原样搜并点名）。
