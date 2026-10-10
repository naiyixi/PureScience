# 中文「主题词」词条：第四种 denoting kind（2026-10-10）

> ⚠️ **状态（执行器，2026-10-10 19:5x 补记）：词表与读数都已实测，但表侧尚未落地。** 落表那一笔与
> **同一时刻在改 `src/shared/chinese-terms.ts` 的另一个写入者**相撞（对方把我的表改动回滚了，
> 并在 19:43 落下一份它自己的 `scripts/verify-mesh-sources.mjs`）⇒ 本轮按常驻纪律**让位**，
> 见队列档 §四十七。下面的 §二 就是重放用的行清单，§四/§五 的读数都真跑过；
> **下一轮重新贴表后必须重跑 §四 与 §五 再声称完成**。

中文表此前有三种 denoting kind：药名（`drug`）、适应证（`indication`）、机构/期刊（`institution`/`journal`），
后来又补了「拿什么去问」（`method`）。**主题词**——问题**关于什么**（细胞凋亡、自噬、氧化应激、
生物标志物、免疫治疗……）——**哪一个都不是**：

- `method` 是「拿什么去问」（随机对照试验、流式细胞术）；主题词是「问的是什么」。
- `indication` 是疾病（肺癌、2 型糖尿病）；主题词是**过程/通路/分子**（凋亡、信号转导、外泌体）。

把它们塞进 `method` 或 `indication` 是**错映射**（不报错，只悄悄把问题换成另一个问题），因此这批词
此前在 PubMed/arXiv 上**整句具名拒答**——而它们恰好是中文临床问题里出现频率最高的一类词。
本批收进**新加的第四种 denoting kind `topic`**（`CHINESE_TERM_KINDS` 里的 `'topic'`），
表里同一个词只出现一次（异写走 `variants`，不另起一行）。

## 一、口径（沿用前两批的两条钉子，不放宽）

**错映射比缺映射更糟**：它不会报错，只会**悄悄把问题换成另一个问题**。所以本批的**英文侧不是我在这里翻的**，
而是**从 MeSH 的查询服务读出来的**：

```
GET https://id.nlm.nih.gov/mesh/lookup/descriptor?label=<english>&match=exact&limit=1
→ {"resource": "http://id.nlm.nih.gov/mesh/D017209", "label": "Apoptosis"}
```

每行记下**它当时返回的描述符号**（`mesh:D…`），任何人都能拿这个号去 `https://id.nlm.nih.gov/mesh/D017209`
核对英文侧到底是不是那个词。取数时间：**2026-10-10**。

**中文侧要如实说明**：中文词形不是 MeSH 给的（MeSH 的描述符是英文的），它是**中文医学文献里通行的写法**。
这一半是**本表的**，不是权威机构的；所以每行的 `source` **只承诺英文侧**。变体也只收**指同一件事**的异写：
`凋亡` → `细胞凋亡`、`突变` → `基因突变`、`耐药性` → `抗药性`（三者各自在 MeSH 里解析到本行的同一个描述符）。

## 二、逐条（表 ↔ 本档互核）

| 中文（canonical） | english                          | source          |
| ----------------- | -------------------------------- | --------------- |
| 细胞凋亡          | apoptosis                        | mesh:D017209    |
| 自噬              | autophagy                        | mesh:D001343    |
| 氧化应激          | oxidative stress                 | mesh:D018384    |
| 生物标志物        | biomarkers                       | mesh:D015415    |
| 免疫治疗          | immunotherapy                    | mesh:D007167    |
| 血管生成          | angiogenesis                     | mesh:D000096482 |
| 细胞增殖          | cell proliferation               | mesh:D049109    |
| 细胞周期          | cell cycle                       | mesh:D002453    |
| 细胞衰老          | cellular senescence              | mesh:D016922    |
| 细胞焦亡          | pyroptosis                       | mesh:D000069292 |
| 铁死亡            | ferroptosis                      | mesh:D000079403 |
| 自噬体            | autophagosomes                   | mesh:D000071182 |
| 肿瘤转移          | neoplasm metastasis              | mesh:D009362    |
| 肿瘤微环境        | tumor microenvironment           | mesh:D059016    |
| 抗药性            | drug resistance                  | mesh:D004351    |
| 炎症              | inflammation                     | mesh:D007249    |
| 炎症因子          | inflammation mediators           | mesh:D018836    |
| 细胞因子          | cytokines                        | mesh:D016207    |
| 肠道菌群          | gastrointestinal microbiome      | mesh:D000069196 |
| 基因突变          | mutation                         | mesh:D009154    |
| 基因表达          | gene expression                  | mesh:D015870    |
| DNA损伤           | DNA damage                       | mesh:D004249    |
| 信号转导          | signal transduction              | mesh:D015398    |
| 内质网应激        | endoplasmic reticulum stress     | mesh:D059865    |
| 上皮间质转化      | epithelial-mesenchymal transition | mesh:D058750    |
| 干细胞            | stem cells                       | mesh:D013234    |
| 外泌体            | exosomes                         | mesh:D055354    |
| 甲基化            | methylation                      | mesh:D008745    |
| 泛素化            | ubiquitination                   | mesh:D054875    |
| 磷酸化            | phosphorylation                  | mesh:D010766    |
| 糖基化            | glycosylation                    | mesh:D006031    |
| 微小RNA           | microRNAs                        | mesh:D035683    |
| 长链非编码RNA     | RNA, long noncoding              | mesh:D062085    |

表的行数与本档的行数由读源测试**双向**钉住（`documented.size === topics.length` + 逐行比对
`english`/`source`）：任一边漂了、或两边一起改了其中一个字段，测试都红。

## 三、刻意未收（宁可缺不要错）

| 词       | 为什么不收                                                                |
| -------- | ------------------------------------------------------------------------- |
| 分子机制 | MeSH `match=exact` **零命中** ⇒ 没有可核对的英文侧                        |
| 免疫逃逸 | 最近的描述符是 `tumor escape`，**比中文词窄**（中文也指病原体免疫逃逸）    |
| 信号通路 | `signal transduction` 是**过程**，通路是它跑的那个**结构**，不是一回事     |

前两条与 method 批的处置一致（零命中不收）；第三条是「同形不同物」那一类，按前一批的判据
（`基因表达` 不是 `基因表达谱` 的变体）**不做**。

## 四、反向核对（一次真实核对，抓到了我手写错的一个号）

写法与前三批相反：**拿英文侧去问 MeSH，要求它回的描述符就是表里记的那个号**。
第一遍 33 行写完就跑了这次核对，`自噬体` 那一行我记的是 `D000071183`，MeSH 回的是 **`D000071182`**
⇒ 一处手写的描述符当场被抓、已改。改后重跑：**rows=33 matched=33 mismatch=0**。

这条值得单列：读源测试只能核对「表 ↔ 本档是否一致」，**两边都写错是它抓不到的**；
反向核对（拿英文侧回到权威服务求号）是唯一抓得住「表自己写错」的动作。

## 五、真读数（改前 / 改后对照，都经应用自己的连接器，一次性探针跑完即删）

**改后**（本批已进表）：

| 连接器 | 请求              | 实际发出                | 回带 `kind` | 结果          |
| ------ | ----------------- | ----------------------- | ----------- | ------------- |
| PubMed | `细胞凋亡 肺癌`   | `apoptosis lung cancer` | `topic`+`indication` | **31,551** |
| PubMed | `自噬 二甲双胍`   | `autophagy metformin`   | `topic`+`drug`       | **946**    |
| arXiv  | `all:铁死亡`      | `all:ferroptosis`       | `topic`（前缀原地保留） | **6**   |

- 第一条把两件事同时钉住：新加的 **topic** 词与既有 **indication** 词在**同一次**改写里各自出现，
  `query_sent` 与真发出去的字符串逐字相同，且只发了 **1 次** HTTP。
- 第三条是 arXiv 的**就地改写**：`all:` 前缀原地保留（拼词式改写会把它挪到别处）。

**改前**（同一配方，但在**改前的提交** `a3eb34bf` 的隔离工作树上跑，`grep -c topic` = 0 确认那棵树没有本批）：

```
PubMed 细胞凋亡 肺癌   → 具名拒答（点名 细胞凋亡），http_calls = 0
PubMed 自噬 二甲双胍   → 具名拒答（点名 自噬），    http_calls = 0
```

⇒ 这是一次**从「问不出口」到「问得出口且真拿到了结果」**的变化，不是把零变成非零。

**拒答仍然按名，且新收的词不许把剩下的中文带过去**（两条都是 0 次请求）：

| 请求                | 结果                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `炎症因子 量子纠缠` | 拒答，点名 `量子纠缠`，并列出**这句里已经映射**的部分 `炎症因子→inflammation mediators` |
| `免疫逃逸 肺癌`     | 拒答，点名 `免疫逃逸`（本批刻意未收的词），列出 `肺癌→lung cancer`        |

第二条是「未收 ≠ 阴性」的可跑证据：未收的主题词与改前**行为完全一致**（按名拒答、一个请求都不发）。

## 六、覆盖面与下一步

- 本批收 33 条主题词（上表）。仍是**采样式**覆盖，不是穷举：`分子机制`/`免疫逃逸`/`信号通路` 三条
  按 §三 的理由不进表；再加词的门槛不变 —— **英文侧能在 MeSH（或同样可核对的权威）里精确定位到**，
  且中文侧与之一一对应，不够格的不进表。
- `topic` 是**跨进程枚举的新值**，落地前逐个消费点核过：`kind` 的唯一消费面是
  `zh_terms.matched[].kind`（JSON 里如实回带，无枚举穷举分支），各连接器只特判 `'connective'`
  ⇒ 新值不需要任何分支改动；`CHINESE_TERM_KINDS` 的读源测试补了 `topic` 的条数下限与合计式，
  并把标题里那个手写的种类数去掉了（它是个会漂的第二真源）。

## 七、重放配方（下一轮照此落地；这批词**当前不在表里**）

1. `src/shared/chinese-terms.ts`：`CHINESE_TERM_KINDS` 加 `'topic'`（放在 `'method'` 之后、`'connective'`
   之前），把 `ChineseDenotingKind` 的注释从「四种类别」改成五种。
2. 把 §二 的 33 行写成 `meshEntry(<中文>, 'topic', <english>, <D 号>[, [<变体>]])` 组成 `TOPICS`，
   并把 `...TOPICS` 加进 `CHINESE_TERMS` 的展开（在 `...METHODS` 之后）。
3. 变体只有三处：`细胞凋亡` → `['凋亡']`、`基因突变` → `['突变']`、`抗药性` → `['耐药性']`。
4. `src/shared/chinese-terms.test.ts`：把首个用例标题里的手写种类数去掉、加 `topic` 的条数下限（≥20）
   并把它加进合计式；再加一条 topic 的读源用例，与 method 那条**同规格**（把解析与比对抽成
   `documentedPairs` / `expectRowsMatchNote` 两个共用助手，断言一字不减：行数双向相等 + 逐行比对
   `english` 与 `source`）。
5. 落地后**必须重跑**：反向核对（用 `scripts/verify-mesh-sources.mjs` —— 它本轮由并发写入者新增，
   做的正是这件事的反方向，且它的行正则对 `kind` 不敏感 ⇒ 天然覆盖 `topic` 行）、§五 的连接器读数、
   `eslint --no-cache .`、双 `tsc`、`bash scripts/pre-push-checks.sh`。
