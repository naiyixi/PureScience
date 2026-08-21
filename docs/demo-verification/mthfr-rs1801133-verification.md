# PureScience Demo 校验报告：MTHFR rs1801133 变异证据摘要（P1 同型）

> 目的：对 PureScience 的变异解读类测试（P1 同型：变异证据与不确定性控制）的真实运行结果做**独立核验**。
> 校验方式：对会话产物中的关键数据点，用**公开 API 直接复查**（不复用会话内结果）——NCBI E-utilities（eutils）、dbSNP API、ClinVar eutils。

---

## 1. 运行概况

| 项目 | 详情 |
|---|---|
| 会话 | 项目 `cmsyvwhpl0001wfsnfshff1pf` / 消息文件 `a061b09c-99e0-47ff-a3ac-b9a2ad90a950` |
| 运行时间 | 2026-08-18（约 30 分钟，status=idle 正常完成） |
| Agent 框架 / 模型 | claude-code / **deepseek-v4-flash**（非旗舰模型） |
| 交付产物 | 2 个：`rs1801133_mthfr_c677t_verdict.md`（10 KB）、`rs1801133_mthfr_c677t_forest.png`（166 KB 森林图） |
| 连接器 | Variants（gnomAD 镜像 + ClinVar 快照 2026-06-06）、Genes & Ontologies（mygene.info/QuickGO/RefSeq）、PubMed |

## 2. 题目（会话标题还原）

查询 rs1801133（MTHFR C677T）变异的临床意义、MTHFR 功能，以及同型半胱氨酸与心血管风险的 meta 分析证据；明确区分数据库分类、文献观察与无法判断的临床问题。

## 3. 独立核验结果（关键！）

### 3.1 变异标识与位置 — 全部通过 ✅

| 报告声称 | 公开 API 复查 | 结果 |
|---|---|---|
| rs1801133 = MTHFR c.665C>T, p.Ala222Val | ClinVar VCV000003520：`NM_005957.5(MTHFR):c.665C>T (p.Ala222Val)` | ✅ 一致 |
| chr1:11,796,321 G>A (GRCh38) | dbSNP refsnp 1801133：`NC_000001.11:g.11796321G>A` | ✅ 一致 |
| 基因 MTHFR | ClinVar genes: MTHFR, geneid 4524 | ✅ 一致 |

### 3.2 ClinVar 临床意义 — 通过 ✅

| 报告声称 | 公开 API 复查（ClinVar eutils esummary） | 结果 |
|---|---|---|
| 临床意义 `drug response` | germline_classification.description = **"drug response"** | ✅ 逐字一致 |
| 审查状态 `reviewed by expert panel` | review_status = **"reviewed by expert panel"** | ✅ 一致 |
| 药理学相关（叶酸/甲氨蝶呤） | trait_set: **methotrexate response - Toxicity**（MedGen C0568062 / MONDO:0034212） | ✅ 一致 |
| 非致病/可能致病 | germline 分类为 drug response（非 pathogenic/LP） | ✅ 一致 |

### 3.3 文献引用 — 7/7 PMID 全部复验通过 ✅

| PMID | 报告标注 | eutils esummary 复查 | 结果 |
|---|---|---|---|
| 12387655 | Klerk 2002, *JAMA* | 2002 JAMA, MTHFR 677C→T CHD meta-analysis | ✅ |
| 12446535 | Wald 2002, *BMJ* | 2002 BMJ, Homocysteine and CVD causality meta-analysis | ✅ |
| 16216822 | Lewis 2005, *BMJ* | 2005 BMJ, MTHFR 677C→T CHD meta-analysis | ✅ |
| 15652605 | Casas 2005, *Lancet* | 2005 Lancet, Homocysteine and stroke, Mendelian randomisation | ✅ |
| 21803414 | Holmes 2011, *Lancet* | 2011 Lancet, dietary folate effect modification, stroke | ✅ |
| 15670035 | Den Heijer 2005, *J Thromb Haemost* | 2005 JTH, Homocysteine/MTHFR venous thrombosis meta-analysis | ✅ |
| 42430052 | Castagna 2026, *Aging Clin Exp Res* | 2026, Hyperhomocysteinemia umbrella review | ✅ |

### 3.4 数据源说明（诚实性备注）
- 等位基因频率（gnomAD r4：外显子 AF ≈ 0.323）来自会话披露的 **2026-06-06 ClinVar/gnomAD 快照**（报告中已明示），非实时查询——未作 live 复核，以快照日期口径引用。
- 12 条 meta 分析 OR/CI 数值来自会话内 PubMed 检索与本地汇总，本次复核验证了**全部引用文献真实存在且对应关系正确**；具体 OR 值未逐条重算（可在复现流程中核对，报告本身已给出 DOI 与样本量）。

## 4. 运行亮点（对外展示讲解点）

1. **不确定性控制到位**：明确区分"ClinVar 数据库分类 / 文献观察 / 本任务无法判断的临床问题"，未将 drug response 写成致病结论。
2. **冲突与分层展示**：遗传学证据 vs 随机对照证据（B 族维生素 RCT 无事件减少）的张力被如实呈现——"因果关系存在争议"。
3. **数值严谨**：森林图 12 行全部带 PMID/DOI/OR(95% CI)/样本量；效应修饰（叶酸强化地区 OR≈1.0）被单列。
4. **边界诚实**：报告注明"live NCBI E-utilities 需配置联系邮箱，本会话使用快照"——工具限制如实披露。

## 5. 已知小瑕疵（不影响结论）
- 该会话使用 gnomAD/ClinVar 快照（2026-06-06）而非 live 查询——对"最新性"要求高的场景建议配置 NCBI 邮箱后重跑。

## 6. 复现指引
新建会话 → 粘贴题目（"查询 rs1801133（MTHFR C677T）的临床意义、功能与心血管风险 meta 证据…"）→ 预授权 Variants / Genes & Ontologies / PubMed 连接器 → 预计 25–40 分钟。

---

## 附录：证据链接

| 数据源 | 链接 |
|---|---|
| ClinVar VCV000003520 | https://www.ncbi.nlm.nih.gov/clinvar/variation/3520/ |
| dbSNP rs1801133 | https://www.ncbi.nlm.nih.gov/snp/1801133 |
| Klerk 2002 (JAMA) | https://pubmed.ncbi.nlm.nih.gov/12387655/ |
| Wald 2002 (BMJ) | https://pubmed.ncbi.nlm.nih.gov/12446535/ |
| Lewis 2005 (BMJ) | https://pubmed.ncbi.nlm.nih.gov/16216822/ |
| Casas 2005 (Lancet) | https://pubmed.ncbi.nlm.nih.gov/15652605/ |
| Holmes 2011 (Lancet) | https://pubmed.ncbi.nlm.nih.gov/21803414/ |
| Den Heijer 2005 (JTH) | https://pubmed.ncbi.nlm.nih.gov/15670035/ |
| Castagna 2026 (Aging Clin Exp Res) | https://pubmed.ncbi.nlm.nih.gov/42430052/ |
