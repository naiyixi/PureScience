---
name: bionexus-clinical-cohort-analysis
contract: '{"id":"bionexus-clinical-cohort-analysis","aliases":["临床队列分析","队列生存分析","cohort survival"],"requires":["input:expression_matrix"],"produces":["review:cohort"],"failure_policy":{"missing_state":"需要队列的表达矩阵与临床字段（生存时间、事件、分组）。先提供这两份数据，再开始分析。"}}'
description: Only if the user explicitly asked for a grade-C heuristic. KM/log-rank on caller arrays; Cox only with lifelines; NNLS only with a signature. Not a default analysis skill. Does not download DepMap.
---

# Clinical cohort helpers

- KM + log-rank are real estimators (grade B).
- `calculate_cox_hazard_ratio` is **lifelines CoxPH** when installed, otherwise an event-rate ratio labeled `event_rate_ratio_not_cox`.
- Synthetic lethality does not fetch CERES matrices.
- Immune NNLS **refuses** without a signature matrix.

Research-use only. Not a clinical biostatistics report.
