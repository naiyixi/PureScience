# KRAS G12C 抑制剂研发情报小 dossier（可复查版）

- **生成日期**：2026-08-22
- **数据来源**：仅 PureScience 公开科学连接器（ChEMBL / ClinicalTrials.gov / PubMed）+ 本地 Python 格式化。**本报告不包含模型记忆补全的数据**。
- **交付物**：`kras_g12c_inhibitors.csv`（汇总表）、`kras_g12c_ic50.png`（IC50 条形图）、`generate_kras_g12c_dossier.py`（生成脚本）。
- **用途声明**：本文档为研发情报 / 文献整理，**不构成治疗建议，不作任何患者层面的结论**。

---

## 1. 方法学与筛选逻辑（ChEMBL）

### 1.1 靶点定位与突变注释的限制
- 主靶点：`CHEMBL2189121` — "GTPase KRas"，Homo sapiens（UniProt 组件 P01116，`target_search gene_symbol=KRAS`）。
- **ChEMBL 没有独立的 "KRAS G12C" 靶点条目**（`target_search target_name=G12C` 返回 0 条；KRAS 基因检索返回的 9 个靶点均非 G12C 专用）。
- 因此 **G12C 突变注释只能从 assay 层识别**：使用生物活性记录中的 `assay_description` 与 `assay_variant_mutation` 两个字段做 `/g12c/i` 文本匹配。

### 1.2 实际筛选步骤（连接器可复核）
1. `get_bioactivity(target_chembl_id=CHEMBL2189121, activity_type=IC50, min_pchembl=7.5, limit=1000)` → 该 pChEMBL 阈值下**全集 617 条**（< 连接器单页上限 1000，可一次性取全，避免分页截断）。
   - 说明：pChEMBL ≥ 7.5 等价于 IC50 ≲ 32 nM。这是为了在**单页内取全**过滤后种群而设的文档化阈值；最终前 5 候选 IC50 ≤ 0.91 nM，均远低于该阈值，**该截断不会排除任何最终候选**。
2. 按 G12C 注释过滤 → 617 条中 **293 条**为 G12C 特异 assay（unit 全部为 nM）。
3. 仅保留**明确 IC50**（`standard_relation == "="`，非 "<" 或 ">" 上限/下限）且 `standard_value` 非空。
4. 按分子（`parent_molecule_chembl_id`）去重，每个分子取最优（最小）IC50。
5. 按 IC50 数值**升序**排序，取前 5 个候选。

### 1.3 覆盖范围与限制
- **只检索了经典 KRAS 单蛋白靶点 CHEMBL2189121**。补充核实：RAS 蛋白家族靶点 `CHEMBL4524006` 在 pChEMBL≥6 下仅有 2 条 IC50，且无 G12C 注释，故未遗漏。
- G12C/C51S/C80L/C118S 为可溶性改造的 G12C 突变构建体（生化核苷酸交换 TR-FRET assay）；该 IC50 为**功能抑制**读数，非结合亲和力（Kd/Ki）。
- ChEMBL 未给这些分子分配首选名或同义词（见 §4 未核实项）。

---

## 2. 最终候选（IC50 升序，前 5）

按数值升序，每个候选保留化合物 ID、assay、IC50、文献/assay 标识：

| # | ChEMBL 分子 | 父分子 | IC50 (nM) | pChEMBL | assay | assay 变体注释 | activity_id | document | 期刊/年 |
|---|------------|--------|----------|---------|-------|----------------|-------------|----------|---------|
| 1 | CHEMBL4855521 | CHEMBL5028342 | 0.51 | 9.29 | CHEMBL4825224 | G12C,C51S,C80L,C118S | 23224505 | CHEMBL4823310 | ACS Med Chem Lett, 2021 |
| 2 | CHEMBL4852458 | CHEMBL4852458 | 0.51 | 9.29 | CHEMBL4825224 | G12C,C51S,C80L,C118S | 23224507 | CHEMBL4823310 | ACS Med Chem Lett, 2021 |
| 3 | CHEMBL4856277 | CHEMBL4856277 | 0.56 | 9.25 | CHEMBL4825224 | G12C,C51S,C80L,C118S | 23224511 | CHEMBL4823310 | ACS Med Chem Lett, 2021 |
| 4 | CHEMBL4856826 | CHEMBL4856826 | 0.90 | 9.05 | CHEMBL4810876 | G12C | 23153271 | CHEMBL4808238 | ACS Med Chem Lett, 2021 |
| 5 | CHEMBL4879271 | CHEMBL4879271 | 0.91 | 9.04 | CHEMBL4825224 | G12C,C51S,C80L,C118S | 23224506 | CHEMBL4823310 | ACS Med Chem Lett, 2021 |

- assay 描述（示例，#1，来自 ChEMBL 记录）：
  "Inhibition of biotinylated KRAS G12C/C51S/C80L/C118S mutant (unknown origin) pretreated for 60 mins followed by recombinant SOS addition by SOS-catalyzed nucleotide exchange-based TR-FRET analysis"
- SMILES（共价丙烯酰胺弹头）已存入 CSV 供结构复核。
- **观察**：纯 IC50 排名下，前 5 均出自两篇 ACS Med Chem Lett 2021 文档（CHEMBL4823310 与 CHEMBL4808238，同一药物化学系列），这是"按 IC50 升序"规则的直接结果。

---

## 3. ClinicalTrials.gov（每个候选 1 条可定位试验）

候选为**未命名化合物**，无法做药物层面匹配；按任务指示以 **KRAS G12C 突变/适应症层面**查询（`search_trials condition=KRAS G12C, study_type=INTERVENTIONAL`，共 168 条），并用 `get_trial_details` 核实了下列试验。**匹配层级在每一行明确标注，不推断候选=试验药物。**

| 候选 | 匹配层级 | NCT | 阶段 | 总体状态 | 申办方 | 干预 | 条件 |
|------|---------|-----|------|----------|--------|------|------|
| #1 | indication/mutation-level（候选未命名） | NCT05920356 | Phase 3 | RECRUITING | Amgen | Sotorasib | NSCLC (KRAS p.G12C) |
| #2 | indication/mutation-level（候选未命名） | NCT04793958 | Phase 3 | ACTIVE_NOT_RECRUITING | Mirati Therapeutics Inc. | MRTX849 (adagrasib) | 晚期/转移性结直肠癌 (KRAS G12C) |
| #3 | indication/mutation-level（候选未命名） | NCT06300177 | Phase 3 | RECRUITING | Chia Tai Tianqing Pharmaceutical Group Co., Ltd. | D-1553 (glecirasib) | NSCLC (KRAS G12C) |
| #4 | indication/mutation-level（候选未命名） | NCT05288205 | Phase 1/2 | RECRUITING | Allist Pharmaceuticals, Inc. | JAB-21822 + JAB-3312 | 晚期实体瘤 (KRAS p.G12C) |
| #5 | indication/mutation-level（候选未命名） | NCT06959589 | Phase 2 | ENROLLING_BY_INVITATION | Second Affiliated Hospital, Zhejiang University | IBI351 + cetuximab β + FOLFIRI | 转移性结直肠癌 (KRAS G12C) |

---

## 4. PubMed（每个候选 ≤ 2 篇）

候选未命名，优先机制或临床证据。下列文献均经 `get_article_metadata` 核实（PMID/标题/期刊/年份/DOI）。

| 候选 | 文献 1 (PMID) | 文献 2 (PMID) |
|------|--------------|--------------|
| #1 | 34413946 — Small Molecule Inhibitors of KRAS G12C Mutant, ACS Med Chem Lett 2021, DOI 10.1021/acsmedchemlett.1c00389（机制综述） | 34161704 — Acquired Resistance to KRASG12C Inhibition in Cancer, N Engl J Med 2021, DOI 10.1056/NEJMoa2105281（临床证据） |
| #2 | 34413946（机制综述） | 33838397 — Targeting mutant KRAS, Curr Opin Chem Biol 2021, DOI 10.1016/j.cbpa.2021.02.010（机制综述） |
| #3 | 34413946（机制综述） | 34161704（临床证据） |
| #4 | 34413946（机制综述） | 34471232 — The KRAS-G12C inhibitor: activity and resistance, Cancer Gene Ther 2022, DOI 10.1038/s41417-021-00383-9（机制/临床综述） |
| #5 | 34413946（机制综述） | 33838397（机制综述） |

---

## 5. 已由连接器核实 ✅ 与 未找到/不能核实 ⚠️

### 已由连接器核实（可追溯）
- **ChEMBL 靶点**：CHEMBL2189121（GTPase KRas, Homo sapiens）；无独立 G12C 靶点条目（已核实检索结果）。
- **候选筛选全程**：617 条 IC50 (pChEMBL≥7.5) → 293 条 G12C 明确 IC50 → 去重后升序取前 5。每个候选的 molecule / assay / activity / document ID 均在 ChEMBL 记录中核实。
- **IC50 数值、单位（nM）、pChEMBL、assay 变体注释、文档期刊与年份**：来自 ChEMBL 记录。
- **ClinicalTrials.gov**：5 个 NCT 的阶段、总体状态、申办方、干预、条件均经 `get_trial_details` 核实；`condition="KRAS G12C"` 匹配总数 168 条已核实。
- **PubMed**：4 篇文献的 PMID、标题、期刊、年份、DOI 经 `get_article_metadata` 核实。

### 未找到 / 不能核实（如实标注，不推断）
- **化合物名称**：ChEMBL 未为这 5 个分子提供首选名或同义词（`compound_search` 返回 pref_name=null, synonyms 为空）。CSV 中以 "N/A (ChEMBL 无首选名)" 标识。
- **报道这些具体化合物的原始论文**：通过标题/短语检索（`KRAS G12C inhibitor`、`G12C[Title]`、`"biotinylated KRAS"`、`"nucleotide exchange"` 等）**未能唯一识别**报道这些分子的原文；仅获得其 ChEMBL 文档元数据（ACS Med Chem Lett, 2021）。因此 §4 提供的是**类级机制/临床文献**，而非各分子的首发文献。
- **药物层面临床试验匹配**：候选未命名，无 "相应药物" 可匹配；所有试验均为 KRAS G12C 突变/适应症层面匹配（已在 CSV 与 §3 明确标注）。
- **临床前活性/选择性与体内疗效、临床阶段数据**：本次任务范围外，未评估。
- **候选化合物的任何治疗用途、有效性或安全性结论**：不提供（见用途声明）。

---

## 6. 图表说明（kras_g12c_ic50.png）

- 横轴：**IC50（nM）**；**线性坐标（linear scale，未使用对数坐标）**——已在图内轴标签与注释中明确标注。
- 每条柱标注 IC50 数值与 pChEMBL；y 轴为 ChEMBL ID 与排序号。
- 图中注明数据源（ChEMBL CHEMBL2189121）与生成日期；生成脚本为 `generate_kras_g12c_dossier.py`。

---

## 7. 复现路径

1. 连接器检索（本报告 §1.2 的步骤）→ 数据已固化为 `kras_g12c_dataset.json`（REPL→Python 交接，未随本报告交付；如需可提供）。
2. `python generate_kras_g12c_dossier.py <dataset.json> <输出目录>` → 生成 `kras_g12c_inhibitors.csv` 与 `kras_g12c_ic50.png`。
3. 本 markdown 为人工整合的说明文档；一切数据以 CSV 中的连接器 ID 为准。
