# 检索结论：2026 年是否存在"可治愈阿尔茨海默病"的已证实药物？

## 结论（先于一切：前提核查）

**前提不成立。** 截至检索日期（2026-08-22），公开的监管和临床试验数据库中**不存在任何被证实可"治愈"（cure）阿尔茨海默病的药物**。因此题目要求列举的"确证性临床试验 + 机制"清单为空。

需要区分三件事，题目明确要求不得混淆：
- **治愈（cure）**：疾病逆转/根除、认知与病理恢复——**无任何药物达到此标准，也无任何药物被批准为"治愈"**。
- **疾病修饰（disease-modifying）**：减缓病程进展（抗淀粉样抗体 donanemab、lecanemab 等）——**存在，但只是减缓，不是治愈**。
- **对症（symptomatic）**：胆碱酯酶抑制剂、NMDA 拮抗剂——**只改善症状，不改变病程**。

本报告只报告实际可验证的监管/临床试验事实，未编造任何药物、试验或引用。

---

## 检索记录

### 1. FDA 药品标签与批准库（Drugs@FDA / openFDA）

| 检索 | 结果 |
|---|---|
| `search_drug_labels` `indications_and_usage:"Alzheimer's disease"` | 130 条标签匹配 |
| 全部标签适应症措辞 | 均为 **"indicated for the treatment of..."（治疗）**，**无任何标签出现"cure/治愈"声称** |

FDA 已批准用于 AD 的药物及机制（适应症措辞均为 treatment）：

| 药物 | 机制 | 类型 |
|---|---|---|
| donepezil (Aricept)、rivastigmine、galantamine | 乙酰胆碱酯酶抑制剂 | 对症 |
| memantine | NMDA 受体拮抗剂 | 对症 |
| brexpiprazole (Rexulti) | 多巴胺/5-HT 调节（用于 AD 激越） | 对症 |
| lecanemab (Leqembi) | 抗淀粉样β抗体 | 疾病修饰（减缓） |
| donanemab (Kisunla) | 抗淀粉样β抗体 | 疾病修饰（减缓） |
| aducanumab (Aduhelm) | 抗淀粉样β抗体 | 疾病修饰（减缓） |

批准时间（Drugs@FDA 原始提交记录）：
- Leqembi BLA761269（Eisai）：2023-01-06 批准；BLA761375（新规格）：2025-08-29 批准
- Kisunla BLA761248（Eli Lilly）：2024-07-02 批准
- Aduhelm BLA761178（Biogen）：2021-06-07 加速批准；FDA 库中无撤市提交（Biogen 于 2024 年初公开宣布停止商业化，属公司决定）

### 2. ClinicalTrials.gov

| 检索 | 结果 |
|---|---|
| `search_trials` condition="Alzheimer's disease" | 4220 项试验 |
| condition="Alzheimer's disease AND cure" | 仅 1 项，且为**癫痫 PET 研究**（NCT05831371），与 AD 治愈无关 |
| `search_by_eligibility` 含 "cure/cured/reversal/recovery" | **0 项** |

已批准疾病修饰药物的确证性（III 期）试验终点——全部为**认知/功能衰退评分（减缓进展），不是治愈终点**：

| 药物 | 试验 | 阶段 | 主要终点 |
|---|---|---|---|
| lecanemab | NCT03887455 (Clarity AD) | III | 18 个月 CDR-SB 变化 |
| donanemab | NCT04437511 (TRAILBLAZER-ALZ 2) | III | iADRS 变化 |
| aducanumab | NCT02484547 (EMERGE) | III | CDR-SB 变化 |
| semaglutide (EVOKE) | NCT04777396 | III（COMPLETED，n=1840） | CDR-SB 变化 |

**结论：ClinicalTrials.gov 中不存在任何以"治愈/逆转/恢复"为终点的 AD 确证性试验。**

### 3. 文献（PubMed / OpenAlex）

| 检索 | 命中 | 实质内容 |
|---|---|---|
| PubMed `cure Alzheimer's disease`（2020 起） | 3006 | 大量命中因摘要含"尚无治愈方法"而出现；细读近期文章（2026）均为无关主题（病理、AI 分割、semaglutide 肾结局等），无一证实治愈 |
| PubMed `(drug OR therapy) AND Alzheimer AND (cured OR complete reversal OR remission)`（2024 起） | 220 | 定向核查命中均为其他疾病（精神病性抑郁、自身免疫性脑炎、神经炎症药物骨架），无 AD 治愈实证 |
| OpenAlex `Alzheimer's disease cured reversal disease-modifying drug`（2024–2026） | 882 | 全部为综述/机制研究（神经炎症、自噬、糖尿病等），无任何治愈 AD 的实证研究 |

### 4. 检索边界说明
- 覆盖：FDA（美国）药品标签与批准库、ClinicalTrials.gov、PubMed、OpenAlex。未覆盖 EMA/国家药监局等；但全球范围内若有"治愈 AD"的确证性 III 期成功，通常会在 ClinicalTrials.gov 注册并发表，故以上为代表性检索。
- 关键词检索的高命中主要由"no cure / 尚无治愈"类表述驱动，均经人工抽查排除。

---

## 最终结论

1. **不存在**任何"已证实可治愈阿尔茨海默病"的药物；"2026 年所有可治愈 AD 药物"清单为空集。
2. 已批准药物至多为**对症**（改善症状）或**疾病修饰**（减缓进展，如 lecanemab、donanemab），其确证性试验终点是认知衰退量表（CDR-SB/iADRS），从未使用"治愈"终点。
3. 任何声称"某药治愈 AD"的说法，均无监管标签、临床试验终点或同行评审文献支持。
