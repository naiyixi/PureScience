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

### 二之二、第二批（2026-10-10，执行器）：设计/统计与检测技术

第一批只盖住「设计词」。中文临床问题的另一半常用**检测与组学技术**（「流式细胞术 急性髓系白血病」、
「影像组学 肺结节」），以及**统计/证据类型**（网络荟萃分析、交叉试验）。这批 23 条按同一门槛收：
英文侧**逐条取自 MeSH 的查询服务**（`match=exact` 命中才收），取数时间 **2026-10-10**。

| 中文（canonical） | english                               | source          |
| ----------------- | ------------------------------------- | --------------- |
| 网络荟萃分析      | network meta-analysis                 | mesh:D000099094 |
| 多中心研究        | multicenter study                     | mesh:D016448    |
| 病例报告          | case reports                          | mesh:D002363    |
| 交叉试验          | cross-over studies                    | mesh:D018592    |
| 影像组学          | radiomics                             | mesh:D000097188 |
| 流式细胞术        | flow cytometry                        | mesh:D005434    |
| 免疫印迹法        | blotting, western                     | mesh:D015153    |
| 酶联免疫吸附测定  | enzyme-linked immunosorbent assay     | mesh:D004797    |
| 质谱分析          | mass spectrometry                     | mesh:D013058    |
| 高通量测序        | high-throughput nucleotide sequencing | mesh:D059014    |
| 全基因组测序      | whole genome sequencing               | mesh:D000073336 |
| 空间转录组学      | spatial transcriptomics               | mesh:D000099285 |
| 类器官            | organoids                             | mesh:D009940    |
| 代谢组学          | metabolomics                          | mesh:D055432    |
| 表观基因组学      | epigenomics                           | mesh:D057890    |
| 分子对接模拟      | molecular docking simulation          | mesh:D062105    |
| 分子动力学模拟    | molecular dynamics simulation         | mesh:D056004    |
| 网络药理学        | network pharmacology                  | mesh:D000091484 |
| 基因敲除          | gene knockout techniques              | mesh:D055786    |
| 基因敲低          | gene knockdown techniques             | mesh:D055785    |
| 免疫荧光技术      | fluorescent antibody technique        | mesh:D005455    |
| 蛋白质互作网络    | protein interaction maps              | mesh:D060066    |
| 生物信息学        | computational biology                 | mesh:D019295    |

**两条口径没变**：① 中文词形不是 MeSH 给的（它的描述符是英文的），这一半是本表的、`source` **只承诺英文侧**；
② 变体只收**指同一件事**的异写（`质谱` = 质谱分析、`二代测序` = 高通量测序、`分子对接` = 分子对接模拟），
不把「相关」当「同义」。

**刻意没做的三项**（不收比错收好）：`敏感性分析` / `亚组分析` / `真实世界研究` —— 在 MeSH 里
`match=exact` **零命中**（实测三条都 MISS），没有可核对的英文侧就不进表；这三个词今天在各连接器上
按各来源自己的政策处置（PubMed/arXiv 具名拒答、OpenAlex 原样搜并点名）。
**另记一条挂账**：纯**主题词**（细胞凋亡、自噬、氧化应激、生物标志物、免疫治疗……）不属于这张表的任何一个
`kind`（`method` 是「拿什么去问」，`indication` 是疾病）⇒ 它们需要**第四种 denoting kind**，
那是一次跨进程枚举变更，不在本笔；已写进队列档 §四十六 作为具名开项。

## 二之二、任何人都能重跑这一步核对（2026-10-10）

`source` 记的是「英文侧从哪个 MeSH 描述符读来」。**这一步本身也是可跑的**，不是一个说法：

```bash
node scripts/verify-mesh-sources.mjs            # 表里每一行有来源的条目
node scripts/verify-mesh-sources.mjs 磁共振成像  # 只查指定的几行
```

它逐条向 NLM 取描述符、把 **NLM 的首选标签**与该行**实际发出去的英文**比对，不一致就非零退出。
**本档落定当天对全表（含后来加入的方法/检测技术类，共 53 行）跑过：53/53 一致。**
刻意不接进 CI —— 它要联网，而"因为第三方慢就红"的车道只会教人忽略它。

**它比的是首选标签，不是"唯一正确"**：若某行的英文刻意用的是 MeSH 的 entry term（例：`生物信息学`
的梅林标签是 `Computational Biology`，而 "Bioinformatics" 是它的 entry term），工具会报不一致 ——
**这正是要的**：偏离必须被看见并在这里写明，而不是等别人比摘要时才发现。

## 三、真机读数（经应用自己的连接器，一次性探针，跑完即删）

| 连接器 | 请求                    | 实际发出                              | 结果        |
| ------ | ----------------------- | ------------------------------------- | ----------- |
| PubMed | `随机对照试验 阿司匹林` | `randomized controlled trial aspirin` | **9,072**   |
| arXiv  | `all:随机对照试验`      | `all:randomized controlled trial`     | **401,679** |

两边的 `zh_terms` 都逐条回带了 `kind: "method"` 与 `english`。**改前**这两个词都不在表里，
因此整句在各连接器上**具名拒答、一个请求都不发**（不是"搜了但零结果"）—— 也就是说这次变化是
**从"问不出口"到"问得出口且真拿到了结果"**，不是把零变成非零。

### 三之二、第二批的读数（同一配方：经应用自己的连接器，一次性探针，跑完即删）

| 连接器 | 请求               | 实际发出                    | 结果                  |
| ------ | ------------------ | --------------------------- | --------------------- |
| PubMed | `影像组学 肺癌`    | `radiomics lung cancer`     | **2,847**             |
| arXiv  | `all:网络荟萃分析` | `all:network meta-analysis` | **338,772**           |
| PubMed | `敏感性分析 肺癌`  | **什么都没发**（具名拒答）  | 报错点名 `敏感性分析` |

- 第一条把两件事同时钉住：新收的 **method** 词（`kind: "method"`, `english: "radiomics"`）与既有的
  **indication** 词在同一次改写里各自出现，`query_sent` 与真发出去的字符串逐字相同。
- 第二条是 arXiv 的**就地改写**读数：前缀 `all:` 原地保留，没有被拼词挪走。
- 第三条是**拒答仍然按名**：`敏感性分析`（MeSH 里 `match=exact` 零命中 ⇒ 刻意未收）让整句
  **一个请求都不发**，错误里点名该词、并列出这句里**已经映射**的部分（`肺癌→lung cancer`）。
  「未收 ≠ 阴性」在这里是可跑的证据，不是一句话。

## 四、覆盖面与下一步

- 两批合计 **53 条** method 词条（30 + 23），覆盖最常见的设计/统计与检测/组学词。仍有大量未收：
  实测在 MeSH 里**零命中**的 `敏感性分析` / `亚组分析` / `真实世界研究` 三条**不进表**（没有可核对的
  英文侧，宁可缺不要错）；`单臂试验` 一类**尚未核对**，核到权威出处再加。
  收词的门槛是**英文侧能在 MeSH（或同样可核对的权威）里精确定位到**，不够格的不进表。
- **主题词（细胞凋亡/自噬/氧化应激/生物标志物/免疫治疗…）是另一类**：它们不属于现有任何 `kind`
  （`method` = 拿什么去问、`indication` = 疾病）⇒ 需要**第四种 denoting kind**，是一次跨进程枚举变更，
  已作为具名开项写进队列档 §四十六，**不要**把它们塞进 `method` 充数。
- 未收 ≠ 被当成阴性：未映射的中文在各连接器上**按各自政策**处理（arXiv/PubMed 具名拒答；OpenAlex 原样搜并点名）。
  这条有可跑读数：本档 §三之二 第三条。
