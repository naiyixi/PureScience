# Assay two-group exploratory analysis — reproducible report

- **Input file:** `/Users/totota/ps-test-data/assay_measurements.csv`
- **Generated:** 2026-08-22 01:26:22 by `assay_analysis.py`
- **Rows / columns:** 24 rows, 4 columns (`sample_id, group, replicate, measurement`)

> **Scope:** This is a software-validation exercise. The pipeline, rules and outputs are checkable and rerunnable; **no biological or clinical claim is made** from the numbers below.

## Pre-specified analysis plan

The rules below were fixed in `assay_analysis.py` **before** running the analyses and apply unchanged:

1. **Complete case** = a row with a non-missing `measurement`.
2. **Extreme value** = a measurement outside its group's Tukey far-out fence `[Q1 − 3·IQR, Q3 + 3·IQR]`, computed per group on complete-case data.
3. **Primary (“raw”) analysis**: all complete cases, no extreme value removed.
4. **Sensitivity analysis**: complete cases **minus** the extreme values defined by rule 2.
5. **Testing protocol** (α = 0.05, two-sided): Shapiro–Wilk per group → Levene (median-centred) → if either group fails normality, report Mann–Whitney U and **do not** force a t-test p-value; otherwise Welch t-test if variances unequal, else Student t-test.
6. No record is silently deleted: missing values and extreme values are reported explicitly.

## 1. Data-quality check (reporting only)

| Check | Result |
|---|---|
| Duplicate `sample_id` | 0 |
| Fully duplicate rows | 0 |
| Missing values per column | {'sample_id': 0, 'group': 0, 'replicate': 0, 'measurement': 1} |
| Group A — rows / non-missing / missing | 12 / 11 / 1 |
| Group B — rows / non-missing / missing | 12 / 12 / 0 |
| `replicate` per group (min–max, n unique) | {'A': {'min': 1, 'max': 12, 'nunique': 12}, 'B': {'min': 1, 'max': 12, 'nunique': 12}} |

Missing values in detail:
- `A03` (group A): `measurement` is missing → excluded from all numeric analyses; counted, not imputed.

Extreme values by the pre-specified 3·IQR fence (per group, complete cases):

| sample_id | group | measurement | group fence [low, high] |
|---|---|---|---|
| A11 | A | 12.210 | [7.595, 12.180] |
| B07 | B | 45.000 | [8.965, 16.368] |

Each sample appears once (24 unique `sample_id`); the `replicate` column is a per-group index (1–12) with no repeated-measure structure, so observations are treated as independent.

## 2. Primary (“raw”) analysis — all complete cases

| Group | n | mean | median | SD | min | Q1 | Q3 | max |
|---|---|---|---|---|---|---|---|---|
| A | 11 | 10.044 | 9.940 | 0.936 | 8.500 | 9.560 | 10.215 | 12.210 |
| B | 12 | 15.466 | 12.635 | 9.362 | 11.750 | 12.137 | 13.195 | 45.000 |

| Assumption check / test | Value |
|---|---|
| Shapiro–Wilk W, p — group A | 0.9098, p=0.2427 |
| Shapiro–Wilk W, p — group B | 0.4164, p=<0.0001 |
| Levene F, p (median-centred) | 0.9907, p=0.3309 |
| **Test used** | **Mann-Whitney U** |
| Test statistic | U (group A) = 4.0000 |
| p-value (two-sided) | 0.0002 |
| Effect size | rank-biserial r (B - A) = 0.9394 |

**Interpretation note:** Normality assumption of the two-sample t-test is violated (Shapiro-Wilk: group A p=0.2427, group B p=<0.0001). No t-test p-value is forced; the distribution-free Mann-Whitney U is reported instead.

Groups were compared as **A vs B** (signed effects are B − A).

## 3. Sensitivity analysis — 3·IQR extremes excluded

| Group | n | mean | median | SD | min | Q1 | Q3 | max |
|---|---|---|---|---|---|---|---|---|
| A | 10 | 9.827 | 9.925 | 0.632 | 8.500 | 9.520 | 10.115 | 10.910 |
| B | 11 | 12.781 | 12.490 | 1.122 | 11.750 | 12.085 | 12.915 | 15.730 |

Excluded extreme values in this analysis: A11, B07. No other records removed.

| Assumption check / test | Value |
|---|---|
| Shapiro–Wilk W, p — group A | 0.9481, p=0.6462 |
| Shapiro–Wilk W, p — group B | 0.7864, p=0.0062 |
| Levene F, p (median-centred) | 0.8094, p=0.3796 |
| **Test used** | **Mann-Whitney U** |
| Test statistic | U (group A) = 0.0000 |
| p-value (two-sided) | 0.0001 |
| Effect size | rank-biserial r (B - A) = 1.0000 |

**Interpretation note:** Normality assumption of the two-sample t-test is violated (Shapiro-Wilk: group A p=0.6462, group B p=0.0062). No t-test p-value is forced; the distribution-free Mann-Whitney U is reported instead.

Groups were compared as **A vs B** (signed effects are B − A).

## 4. Raw vs sensitivity: how robust is the group contrast?

| Analysis | median B − median A | mean B − mean A | n (A, B) | test | p |
|---|---|---|---|---|---|
| primary_raw | 2.695 | 5.422 | (11, 12) | Mann-Whitney U | 0.0002 |
| sensitivity | 2.565 | 2.954 | (10, 11) | Mann-Whitney U | 0.0001 |

The single `45.00` value in group B dominates the raw-data summaries and drives the raw-analysis result. The sensitivity analysis re-estimates the group contrast without the pre-specified extreme values to check whether the qualitative conclusion holds.

## 5. Reproducibility

From any directory containing `assay_measurements.csv`, run:

```bash
python assay_analysis.py /path/to/assay_measurements.csv .
```

The script regenerates `assay_summary.csv`, `assay_tests.csv`, `assay_dotplot.png`, `assay_summary_plot.png` and this report in `.`. Dependencies: Python ≥3.10, `numpy`, `pandas`, `scipy`, `matplotlib`. The jitter seed and all thresholds are fixed constants, so outputs are deterministic.

## 6. Limitations

- Sample sizes are small (n ≈ 10–12 per group); normality tests have limited power and results are illustrative of the software pipeline, not of the biology.
- The extreme-value rule is pre-specified but still a modelling choice; other fences would flag other sets.
- The missing value (`A03`) is excluded (complete-case); no imputation was performed.
- Everything above is a computational exercise: **no biological or clinical conclusion is implied.**
