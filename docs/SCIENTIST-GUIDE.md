# PureScience 科学家案例教程

> 真实跑通的完整流程，覆盖计算生物学与文献研究的核心场景。每个案例给出会话提示词，可直接复制使用。

---

## 案例 1：分子对接 + 分子动力学（SARS-CoV-2 Mpro × nirmatrelvir）

**目标**：评估已上市抗新冠药物 nirmatrelvir（Paxlovid 成分）与 3CL 蛋白酶的相互作用强度与结合模式稳定性。

**会话提示词**：

```
执行 SARS-CoV-2 Mpro + nirmatrelvir 复合物的分子对接与动力学模拟：
1. 下载 SARS-CoV-2 Mpro 结构 PDB 7VH8（nirmatrelvir 共晶结构）
2. 用 openbabel 准备受体（去水/配体/加氢，输出 pdbqt）
3. 从 PubChem CID 155903259 获取 nirmatrelvir 结构，rdkit 生成 3D 构象，meeko 生成配体 pdbqt
4. 用 AutoDock Vina 对接（活性口袋 Cys145，盒子 22³ Å，exhaustiveness 32）
5. 用 antechamber (GAFF2 + AM1-BCC) 参数化配体，tleap 构建复合物体系
6. 用 OpenMM 做能量最小化和动力学平衡
7. 输出：对接打分表 + 能量轨迹 + 结合模式分析报告
```

**实际结果**：

| 阶段 | 结果 |
|---|---|
| 分子对接 | **-9.21 kcal/mol**（9 个 pose，最佳 pose 与共晶位姿 RMSD=0.00 Å） |
| 配体验证 | C₂₃H₃₂F₃N₅O₄（与 nirmatrelvir 一致，C≡N 三键 + 4 个 C=O 正确） |
| 力场参数化 | GAFF2 + AM1-BCC（antechamber Status: pass，tleap Errors = 0） |
| 动力学 | 20 ps NVT 平衡完成，能量收敛（-6264 ± 40 kcal/mol） |
| 结合强度 | -9.21 kcal/mol 对应强抑制区间（文献典型值 -7~-9） |

**要点**：
- 用 **7VH8**（共晶结构）而非 6LU7，确保对接/模拟坐标系一致
- 对接最优 pose 与结晶位姿 RMSD=0 是 redock 质量验证的关键证据
- 显式水盒模拟建议 16GB+ 内存；8GB 机器可用 GBSA 隐式溶剂模式

---

## 案例 2：科研文献综述（多源检索 + 全文精读）

**目标**：快速掌握某领域最新进展，生成带引用的结构化综述。

**会话提示词**：

```
检索 2024-2026 年 postbiotics（后生元）领域的研究进展：
1. PubMed 检索相关文献（获取标题/摘要/PMID）
2. OpenAlex 补充检索（获取引用量数据）
3. 筛选高相关度论文，用 arxiv_get_fulltext 抓取全文（如有）
4. 总结：定义共识、关键机制、临床研究证据、代表菌株与产物
5. 输出带引用的结构化报告
```

**实际结果**：
- PubMed 检索 **1799 篇** + OpenAlex **11003 篇**
- 批量获取 100 篇论文元数据
- 覆盖 2025 国际共识声明（Nat Rev Gastroenterol Hepatol）、热灭活 Akkermansia RCT 等关键文献
- 生成完整综述（含 DOI 引用、机制图谱、临床证据分级）

**要点**：
- 先元数据筛选（Level 0/1），再全文精读（Level 4/5）——分层检索省时间
- arxiv_get_fulltext 可抓取 HTML 版全文（41K 字符级）

---

## 案例 3：数据分析 + 可视化

**目标**：分析实验数据并生成图表。

**会话提示词**：

```
读取项目中的 data.csv，分析关键变量相关性：
1. 数据清洗（缺失值/异常值处理）
2. 描述性统计 + 相关性分析
3. 生成 3 张图：分布图、相关性热图、回归拟合图
4. 输出分析结论
```

**要点**：
- Notebook 中 matplotlib/plotly 生成的图表会直接显示在会话中（含图片输出预览）
- 图表文件自动归档为可检查的研究产物

---

## 内置科学数据连接器（24 个）

| 领域 | 连接器 |
|---|---|
| 文献 | PubMed、OpenAlex、arXiv（含全文）、Semantic Scholar |
| 化学 | PubChem、ChemSpider、ChEMBL |
| 结构生物学 | PDB、UniProt、AlphaFold |
| 基因/基因组 | NCBI Gene、Ensembl、STRING |
| 临床 | ClinicalTrials.gov、DrugBank |
| 通用 | Crossref、BioRxiv、MedRxiv 等 |

## 科学计算环境

PureScience 内置的科学计算环境（自动管理 Python + 科学包）：

| 工具 | 用途 |
|---|---|
| rdkit | 分子处理/构象生成 |
| openbabel | 格式转换/pdbqt 准备 |
| meeko | 配体 pdbqt 生成 |
| AutoDock Vina | 分子对接 |
| ambertools (antechamber) | 配体力场参数化（GAFF2/AM1-BCC） |
| OpenMM | 分子动力学模拟 |
| numpy/scipy/pandas/matplotlib | 数据分析与可视化 |

> 8GB 内存机器建议：GBSA 隐式溶剂模拟（4,700 原子级）；显式水盒（20 万+原子）建议 16GB+。
