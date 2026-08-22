#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
assay_analysis.py -- reproducible two-group exploratory analysis
================================================================

Input : assay_measurements.csv   (columns: sample_id, group, replicate, measurement)
Outputs (written to the current directory, or the directory given as the
second CLI argument):
    assay_summary.csv       per-group summary stats per analysis
    assay_tests.csv         assumption checks + test results per analysis
    assay_dotplot.png       raw dot plot (individual points by group)
    assay_summary_plot.png  group summary plot (primary and sensitivity)
    assay_analysis.md       full report

PRE-SPECIFIED ANALYSIS PLAN (fixed below, before any analysis is run)
---------------------------------------------------------------------
QC (reporting only -- no record is silently deleted):
    * duplicate sample_id / fully-duplicate rows
    * missing values (count + rows)
    * group sizes (rows and non-missing measurements)
    * extreme values identified by the rule below (reported, not deleted)

Definitions:
    * Complete case = a row with a non-missing `measurement`.
    * Extreme value = a measurement outside its group's Tukey far-out fence
          [Q1 - 3*IQR, Q3 + 3*IQR]  (Q1/Q3 = 25th/75th percentile, IQR = Q3-Q1),
          computed per group on complete-case data.

Analysis 1 (PRIMARY, "raw")  : all complete cases; no extreme value removed.
Analysis 2 (SENSITIVITY)     : complete cases minus the extreme values defined
                               by the rule above. The flagged set is identical
                               in both analyses; it is only *applied* here.

Testing protocol (pre-specified, alpha = 0.05, two-sided):
    1. Normality per group .............. Shapiro-Wilk.
    2. Variance homogeneity .............. Levene (median-centred).
    3. Test selection:
         - if either group fails normality (p < alpha):
             report Mann-Whitney U and STATE that the two-sample t-test is
             not applicable because its normality assumption is violated
             (no t p-value is forced).
         - else if Levene p < alpha: Welch t-test (unequal variances).
         - else: Student t-test (equal variances).
    Effect size: Cohen's d (pooled SD, group B minus group A) reported
    descriptively; for Mann-Whitney U also the rank-biserial correlation.

This script is a SOFTWARE VALIDATION exercise. It makes no biological or
clinical claims.

Usage:
    python assay_analysis.py [input_csv] [outdir]
"""

import os
import sys

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats

ALPHA = 0.05          # significance level for assumption checks and tests
SEED = 20260822       # fixed jitter seed for reproducible figures
DEFAULT_INPUT = "/Users/totota/ps-test-data/assay_measurements.csv"


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def fmt_p(p):
    """Format a p-value compactly (never print a bare machine float)."""
    if pd.isna(p):
        return "NA"
    if p < 0.0001:
        return "<0.0001"
    return f"{p:.4f}"


def tukey_fences(x):
    """Tukey far-out fences [Q1-3*IQR, Q3+3*IQR] on a numeric array."""
    q1, q3 = np.quantile(x, [0.25, 0.75])
    iqr = q3 - q1
    return q1 - 3.0 * iqr, q3 + 3.0 * iqr


def summarize(x):
    """Per-group summary statistics on an array-like of complete values."""
    x = np.asarray(x, dtype=float)
    q1, q3 = np.quantile(x, [0.25, 0.75])
    return {
        "n": int(len(x)),
        "mean": float(x.mean()),
        "median": float(np.median(x)),
        "sd": float(x.std(ddof=1)) if len(x) > 1 else float("nan"),
        "min": float(x.min()),
        "q1": float(q1),
        "q3": float(q3),
        "max": float(x.max()),
    }


def cohen_d(a, b):
    """Cohen's d using the pooled SD, signed as mean(B) - mean(A)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    na, nb = len(a), len(b)
    sp = np.sqrt(((na - 1) * a.var(ddof=1) + (nb - 1) * b.var(ddof=1)) / (na + nb - 2))
    if sp == 0:
        return float("nan")
    return float((b.mean() - a.mean()) / sp)


def run_test_protocol(a, b):
    """
    Apply the pre-specified testing protocol.
    Returns a dict with assumption checks, chosen test and result, and a
    human-readable note explaining the choice.
    """
    a, b = np.asarray(a, float), np.asarray(b, float)
    na, nb = len(a), len(b)
    sh_a = stats.shapiro(a) if na >= 3 else (float("nan"), float("nan"))
    sh_b = stats.shapiro(b) if nb >= 3 else (float("nan"), float("nan"))
    w_a, p_a = sh_a
    w_b, p_b = sh_b

    try:
        lev = stats.levene(a, b, center="median")   # F, p
        f_lev, p_lev = lev.statistic, lev.pvalue
    except Exception:
        f_lev, p_lev = float("nan"), float("nan")

    normal_a = (na < 3) or (p_a >= ALPHA)
    normal_b = (nb < 3) or (p_b >= ALPHA)

    res = {
        "nA": na, "nB": nb,
        "shapiro_W_A": w_a, "shapiro_p_A": p_a,
        "shapiro_W_B": w_b, "shapiro_p_B": p_b,
        "levene_F": f_lev, "levene_p": p_lev,
        "normal_A": bool(normal_a), "normal_B": bool(normal_b),
        "test": None, "stat_name": None, "statistic": float("nan"),
        "p_value": float("nan"), "effect_name": None, "effect": float("nan"),
        "note": "",
    }

    if not (normal_a and normal_b):
        # Normality violated -> no t-test; Mann-Whitney U only.
        mw = stats.mannwhitneyu(a, b, alternative="two-sided")
        u1 = mw.statistic
        rrb = 1.0 - 2.0 * u1 / (na * nb)          # rank-biserial, A vs B
        res.update({
            "test": "Mann-Whitney U",
            "stat_name": "U (group A)",
            "statistic": float(u1),
            "p_value": float(mw.pvalue),
            "effect_name": "rank-biserial r (B - A)",
            "effect": float(rrb),
            "note": ("Normality assumption of the two-sample t-test is "
                     f"violated (Shapiro-Wilk: group A p={fmt_p(p_a)}, "
                     f"group B p={fmt_p(p_b)}). No t-test p-value is forced; "
                     "the distribution-free Mann-Whitney U is reported instead."),
        })
    else:
        equal_var = p_lev >= ALPHA
        tt = stats.ttest_ind(a, b, equal_var=equal_var)
        d = cohen_d(a, b)
        test_name = "Student t-test" if equal_var else "Welch t-test"
        var_note = (f"Levene p={fmt_p(p_lev)} (variances {('equal' if equal_var else 'unequal')})")
        res.update({
            "test": test_name,
            "stat_name": "t",
            "statistic": float(tt.statistic),
            "df": float(tt.df) if hasattr(tt, "df") else float("nan"),
            "p_value": float(tt.pvalue),
            "effect_name": "Cohen's d (pooled SD)",
            "effect": float(d),
            "note": f"Normality OK (Shapiro-Wilk p_A={fmt_p(p_a)}, p_B={fmt_p(p_b)}); {var_note}.",
        })
    return res


# --------------------------------------------------------------------------
# QC
# --------------------------------------------------------------------------
def run_qc(df):
    qc = {}
    qc["n_rows"] = len(df)
    qc["columns"] = list(df.columns)
    dup_sid = df["sample_id"].duplicated(keep=False)
    qc["dup_sample_id"] = int(dup_sid.sum())
    qc["dup_sample_id_rows"] = df.loc[dup_sid, "sample_id"].tolist()
    qc["dup_rows"] = int(df.duplicated(keep=False).sum())
    qc["missing_by_col"] = {c: int(df[c].isna().sum()) for c in df.columns}
    qc["missing_rows"] = df.loc[df.isna().any(axis=1)].to_dict("records")
    qc["groups"] = df["group"].unique().tolist()
    qc["group_sizes"] = {
        g: {
            "n_rows": int((df["group"] == g).sum()),
            "n_measurement": int(df.loc[df["group"] == g, "measurement"].notna().sum()),
            "n_missing": int(df.loc[df["group"] == g, "measurement"].isna().sum()),
        }
        for g in qc["groups"]
    }
    qc["replicate_per_group"] = {
        g: {"min": int(df.loc[df["group"] == g, "replicate"].min()),
            "max": int(df.loc[df["group"] == g, "replicate"].max()),
            "nunique": int(df.loc[df["group"] == g, "replicate"].nunique())}
        for g in qc["groups"]
    }
    # Extreme values per the pre-specified rule (complete-case, per group).
    flags = []
    cc = df.dropna(subset=["measurement"])
    for g in qc["groups"]:
        sub = cc.loc[cc["group"] == g, "measurement"]
        lo, hi = tukey_fences(sub)
        flagged = cc.loc[(cc["group"] == g) & ((cc["measurement"] < lo) | (cc["measurement"] > hi))]
        for _, r in flagged.iterrows():
            flags.append({
                "sample_id": r["sample_id"], "group": r["group"],
                "measurement": float(r["measurement"]), "fence_low": lo, "fence_high": hi,
            })
    qc["extreme_flags"] = flags
    qc["fences"] = {
        g: {
            "low": float(tukey_fences(cc.loc[cc["group"] == g, "measurement"])[0]),
            "high": float(tukey_fences(cc.loc[cc["group"] == g, "measurement"])[1]),
        }
        for g in qc["groups"]
    }
    return qc


# --------------------------------------------------------------------------
# analysis driver
# --------------------------------------------------------------------------
def run_analysis(df, qc, label, apply_extreme_removal):
    """Run one analysis. Returns {summary: {...per group}, test: {...}, removed: [...]}."""
    cc = df.dropna(subset=["measurement"]).copy()

    removed_ids = []
    if apply_extreme_removal:
        flag_ids = {f["sample_id"] for f in qc["extreme_flags"]}
        cc = cc[~cc["sample_id"].isin(flag_ids)].copy()
        removed_ids = sorted(flag_ids)

    groups = sorted(df["group"].unique().tolist())
    a = cc.loc[cc["group"] == groups[0], "measurement"].to_numpy(dtype=float)
    b = cc.loc[cc["group"] == groups[1], "measurement"].to_numpy(dtype=float)
    # 'a'/'b' are ordered by sorted(group) so that the signed effect is stable.

    summaries = {}
    for g, x in zip(groups, [a, b]):
        summaries[g] = summarize(x)

    test = run_test_protocol(a, b)
    test["groups_compared"] = (groups[0], groups[1])

    return {
        "label": label,
        "apply_extreme_removal": apply_extreme_removal,
        "removed_ids": removed_ids,
        "summaries": summaries,
        "test": test,
        "groups": groups,
    }


# --------------------------------------------------------------------------
# figures
# --------------------------------------------------------------------------
def jitter(n, rng, width=0.16):
    return rng.uniform(-width, width, size=n)


def make_dotplot(df, qc, out_path):
    """Raw dot plot: every individual measurement, by group."""
    rng = np.random.default_rng(SEED)
    colors = {"A": "#4C72B0", "B": "#DD8452"}
    fig, ax = plt.subplots(figsize=(6.5, 5.0))

    for i, g in enumerate(qc["groups"]):
        sub = df.loc[df["group"] == g]
        x = sub["measurement"].dropna()
        xs = np.full(len(x), i) + jitter(len(x), rng)
        ax.scatter(xs, x, s=55, color=colors[g], alpha=0.75, edgecolor="white",
                   linewidth=0.6, label=f"Group {g} (n={len(x)})", zorder=3)

    # highlight pre-specified extreme values
    for f in qc["extreme_flags"]:
        gidx = qc["groups"].index(f["group"])
        ax.scatter(gidx, f["measurement"], s=120, facecolor="none",
                   edgecolor="#C0392B", linewidth=1.8, zorder=5)
        ax.annotate(f"{f['sample_id']} = {f['measurement']:.2f}",
                    (gidx, f["measurement"]), textcoords="offset points",
                    xytext=(8, 6), fontsize=8, color="#C0392B", zorder=6)

    ax.set_xticks(range(len(qc["groups"])))
    ax.set_xticklabels([f"Group {g}" for g in qc["groups"]])
    ax.set_ylabel("Measurement")
    ax.set_title("Raw assay measurements by group (complete cases)")
    ax.legend(loc="lower right", framealpha=0.9, fontsize=8)
    ax.set_ylim(bottom=-1)
    ax.grid(axis="y", alpha=0.3)

    miss = qc["missing_rows"]
    miss_txt = ("", f"; missing {miss[0]['sample_id']} shown nowhere (value absent)") if miss else ""
    fig.text(0.01, 0.01, "Individual points jittered horizontally. Red ring = extreme value "
                          "by pre-specified 3*IQR far-out fence. "
                          f"Missing values: {len(miss)} row(s){miss_txt}.",
             fontsize=7.5, color="#555555")
    fig.tight_layout(rect=[0, 0.03, 1, 1])
    fig.savefig(out_path, dpi=200)
    plt.close(fig)


def make_summary_plot(res_primary, res_sens, out_path):
    """Group summary plot: one panel per analysis."""
    rng = np.random.default_rng(SEED)
    colors = {"A": "#4C72B0", "B": "#DD8452"}
    panels = [("Primary (all complete cases)", res_primary),
              ("Sensitivity (3*IQR extremes excluded)", res_sens)]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.6))

    for ax, (title, res) in zip(axes, panels):
        groups = res["groups"]
        for i, g in enumerate(groups):
            s = res["summaries"][g]
            # individual points come from the same dataset used in the analysis
            # (recomputed inside run_analysis -> we store full values in the results)
            vals = np.asarray(res["values"][g], dtype=float)
            xs = np.full(len(vals), i) + jitter(len(vals), rng)
            ax.scatter(xs, vals, s=40, color=colors[g], alpha=0.65,
                       edgecolor="white", linewidth=0.5, zorder=3)
            # median line
            ax.hlines(s["median"], i - 0.22, i + 0.22, color=colors[g], linewidth=2.2, zorder=4)
            # mean marker + SD error bar
            ax.errorbar(i, s["mean"], yerr=s["sd"], fmt="D", color="black",
                        markersize=6, capsize=4, linewidth=1.2, zorder=5)
            ax.text(i + 0.24, s["mean"], f"mean={s['mean']:.2f}\nsd={s['sd']:.2f}\nmed={s['median']:.2f}",
                    fontsize=7.5, va="center", color="#333333")
            ax.text(i, min(vals) - (np.ptp(vals) * 0.16 if np.ptp(vals) else 1),
                    f"n={s['n']}", ha="center", fontsize=8, color=colors[g])
        ax.set_xticks(range(len(groups)))
        ax.set_xticklabels([f"Group {g}" for g in groups])
        ax.set_ylabel("Measurement")
        ax.set_title(title, fontsize=10)
        ax.grid(axis="y", alpha=0.3)
        ax.set_ylim(bottom=-1)

    fig.text(0.01, 0.01, "Points = individual measurements (jittered). Horizontal bar = median; "
                         "black diamond = mean with +/- 1 SD whisker. Extreme values excluded "
                         "in the sensitivity panel.",
             fontsize=7.5, color="#555555")
    fig.tight_layout(rect=[0, 0.03, 1, 1])
    fig.savefig(out_path, dpi=200)
    plt.close(fig)


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------
def build_report(df, qc, res_primary, res_sens, input_csv, outdir):
    L = []
    A = L.append

    A("# Assay two-group exploratory analysis — reproducible report")
    A("")
    A(f"- **Input file:** `{input_csv}`")
    A(f"- **Generated:** {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M:%S')} by `assay_analysis.py`")
    A(f"- **Rows / columns:** {df.shape[0]} rows, {df.shape[1]} columns (`{', '.join(df.columns)}`)")
    A("")
    A("> **Scope:** This is a software-validation exercise. The pipeline, rules and outputs are "
      "checkable and rerunnable; **no biological or clinical claim is made** from the numbers below.")
    A("")

    # --- pre-specified plan ---
    A("## Pre-specified analysis plan")
    A("")
    A("The rules below were fixed in `assay_analysis.py` **before** running the analyses "
      "and apply unchanged:")
    A("")
    A("1. **Complete case** = a row with a non-missing `measurement`.")
    A("2. **Extreme value** = a measurement outside its group's Tukey far-out fence "
      "`[Q1 − 3·IQR, Q3 + 3·IQR]`, computed per group on complete-case data.")
    A("3. **Primary (“raw”) analysis**: all complete cases, no extreme value removed.")
    A("4. **Sensitivity analysis**: complete cases **minus** the extreme values defined by rule 2.")
    A("5. **Testing protocol** (α = 0.05, two-sided): Shapiro–Wilk per group → Levene "
      "(median-centred) → if either group fails normality, report Mann–Whitney U and **do not** "
      "force a t-test p-value; otherwise Welch t-test if variances unequal, else Student t-test.")
    A("6. No record is silently deleted: missing values and extreme values are reported explicitly.")
    A("")

    # --- QC ---
    A("## 1. Data-quality check (reporting only)")
    A("")
    A("| Check | Result |")
    A("|---|---|")
    A(f"| Duplicate `sample_id` | {qc['dup_sample_id']} |")
    A(f"| Fully duplicate rows | {qc['dup_rows']} |")
    A(f"| Missing values per column | {qc['missing_by_col']} |")
    for g in qc["groups"]:
        s = qc["group_sizes"][g]
        A(f"| Group {g} — rows / non-missing / missing | {s['n_rows']} / {s['n_measurement']} / {s['n_missing']} |")
    A(f"| `replicate` per group (min–max, n unique) | {qc['replicate_per_group']} |")
    A("")
    A("Missing values in detail:")
    if qc["missing_rows"]:
        for r in qc["missing_rows"]:
            A(f"- `{r['sample_id']}` (group {r['group']}): `measurement` is missing → excluded from all "
              "numeric analyses; counted, not imputed.")
    else:
        A("- none")
    A("")
    A(f"Extreme values by the pre-specified 3·IQR fence (per group, complete cases):")
    A("")
    A("| sample_id | group | measurement | group fence [low, high] |")
    A("|---|---|---|---|")
    for f in qc["extreme_flags"]:
        A(f"| {f['sample_id']} | {f['group']} | {f['measurement']:.3f} | "
          f"[{f['fence_low']:.3f}, {f['fence_high']:.3f}] |")
    if not qc["extreme_flags"]:
        A("| — | none | | |")
    A("")
    A("Each sample appears once (24 unique `sample_id`); the `replicate` column is a per-group "
      "index (1–12) with no repeated-measure structure, so observations are treated as independent.")
    A("")

    # --- results ---
    def render_block(res, heading):
        A(f"## {heading}")
        A("")
        A("| Group | n | mean | median | SD | min | Q1 | Q3 | max |")
        A("|---|---|---|---|---|---|---|---|---|")
        for g in res["groups"]:
            s = res["summaries"][g]
            A(f"| {g} | {s['n']} | {s['mean']:.3f} | {s['median']:.3f} | {s['sd']:.3f} | "
              f"{s['min']:.3f} | {s['q1']:.3f} | {s['q3']:.3f} | {s['max']:.3f} |")
        A("")
        if res["removed_ids"]:
            A(f"Excluded extreme values in this analysis: {', '.join(res['removed_ids'])}. "
              "No other records removed.")
            A("")
        t = res["test"]
        A("| Assumption check / test | Value |")
        A("|---|---|")
        A(f"| Shapiro–Wilk W, p — group {res['groups'][0]} | {t['shapiro_W_A']:.4f}, p={fmt_p(t['shapiro_p_A'])} |")
        A(f"| Shapiro–Wilk W, p — group {res['groups'][1]} | {t['shapiro_W_B']:.4f}, p={fmt_p(t['shapiro_p_B'])} |")
        A(f"| Levene F, p (median-centred) | {t['levene_F']:.4f}, p={fmt_p(t['levene_p'])} |")
        A(f"| **Test used** | **{t['test']}** |")
        if t["test"]:
            A(f"| Test statistic | {t['stat_name']} = {t['statistic']:.4f}"
              + (f" (df={t['df']:.2f})" if "df" in t and not pd.isna(t.get("df")) else "") + " |")
            A(f"| p-value (two-sided) | {fmt_p(t['p_value'])} |")
        A(f"| Effect size | {t['effect_name']} = {t['effect']:.4f} |")
        A("")
        A(f"**Interpretation note:** {t['note']}")
        A("")
        A(f"Groups were compared as **{res['groups'][0]} vs {res['groups'][1]}** "
          "(signed effects are B − A).")
        A("")

    render_block(res_primary, "2. Primary (“raw”) analysis — all complete cases")
    render_block(res_sens, "3. Sensitivity analysis — 3·IQR extremes excluded")

    # --- comparison ---
    A("## 4. Raw vs sensitivity: how robust is the group contrast?")
    A("")
    def meddiff(res):
        return res["summaries"][res["groups"][1]]["median"] - res["summaries"][res["groups"][0]]["median"]
    def meandiff(res):
        return res["summaries"][res["groups"][1]]["mean"] - res["summaries"][res["groups"][0]]["mean"]
    A("| Analysis | median B − median A | mean B − mean A | n (A, B) | test | p |")
    A("|---|---|---|---|---|---|")
    for res in (res_primary, res_sens):
        t = res["test"]
        A(f"| {res['label']} | {meddiff(res):.3f} | {meandiff(res):.3f} | "
          f"({res['summaries'][res['groups'][0]]['n']}, {res['summaries'][res['groups'][1]]['n']}) | "
          f"{t['test']} | {fmt_p(t['p_value'])} |")
    A("")
    A("The single `45.00` value in group B dominates the raw-data summaries and drives the "
      "raw-analysis result. The sensitivity analysis re-estimates the group contrast without the "
      "pre-specified extreme values to check whether the qualitative conclusion holds.")
    A("")

    # --- reproducibility ---
    A("## 5. Reproducibility")
    A("")
    A("From any directory containing `assay_measurements.csv`, run:")
    A("")
    A("```bash")
    A("python assay_analysis.py /path/to/assay_measurements.csv .")
    A("```")
    A("")
    A(f"The script regenerates `assay_summary.csv`, `assay_tests.csv`, `assay_dotplot.png`, "
      f"`assay_summary_plot.png` and this report in `{outdir}`. Dependencies: Python ≥3.10, "
      "`numpy`, `pandas`, `scipy`, `matplotlib`. The jitter seed and all thresholds are fixed "
      "constants, so outputs are deterministic.")
    A("")

    # --- limitations ---
    A("## 6. Limitations")
    A("")
    A("- Sample sizes are small (n ≈ 10–12 per group); normality tests have limited power and "
      "results are illustrative of the software pipeline, not of the biology.")
    A("- The extreme-value rule is pre-specified but still a modelling choice; other fences "
      "would flag other sets.")
    A("- The missing value (`A03`) is excluded (complete-case); no imputation was performed.")
    A("- Everything above is a computational exercise: **no biological or clinical conclusion "
      "is implied.**")
    A("")

    return "\n".join(L)


def main():
    args = sys.argv[1:]
    input_csv = args[0] if len(args) > 0 else DEFAULT_INPUT
    outdir = args[1] if len(args) > 1 else os.getcwd()
    os.makedirs(outdir, exist_ok=True)

    df = pd.read_csv(input_csv)
    df["group"] = df["group"].astype(str)

    # --- QC ---
    qc = run_qc(df)
    n_total_complete = int(df["measurement"].notna().sum())
    print(f"[QC] rows={qc['n_rows']}, complete-case n={n_total_complete}, "
          f"missing={qc['missing_by_col']['measurement']}, "
          f"extreme flags={len(qc['extreme_flags'])}")

    # --- analyses ---
    res_primary = run_analysis(df, qc, "primary_raw", apply_extreme_removal=False)
    res_sens = run_analysis(df, qc, "sensitivity", apply_extreme_removal=True)

    # store full per-group value arrays for the summary plot
    cc = df.dropna(subset=["measurement"])
    flag_ids = {f["sample_id"] for f in qc["extreme_flags"]}
    for res in (res_primary, res_sens):
        sub = cc if res is res_primary else cc[~cc["sample_id"].isin(flag_ids)]
        res["values"] = {g: sub.loc[sub["group"] == g, "measurement"].to_numpy()
                         for g in res["groups"]}

    # --- outputs ---
    # 1) assay_summary.csv : per-group stats per analysis
    sum_rows = []
    for res in (res_primary, res_sens):
        for g in res["groups"]:
            s = res["summaries"][g]
            sum_rows.append({
                "analysis": res["label"],
                "group": g,
                "n": s["n"], "mean": s["mean"], "median": s["median"], "sd": s["sd"],
                "min": s["min"], "q1": s["q1"], "q3": s["q3"], "max": s["max"],
                "n_extreme_excluded": len(res["removed_ids"]),
            })
    pd.DataFrame(sum_rows).to_csv(os.path.join(outdir, "assay_summary.csv"), index=False)

    # 2) assay_tests.csv : assumption checks + tests per analysis
    test_rows = []
    for res in (res_primary, res_sens):
        t = res["test"]
        test_rows.append({
            "analysis": res["label"],
            "groups_compared": f"{res['groups'][0]} vs {res['groups'][1]}",
            "n_A": t["nA"], "n_B": t["nB"],
            "shapiro_W_A": t["shapiro_W_A"], "shapiro_p_A": t["shapiro_p_A"],
            "shapiro_W_B": t["shapiro_W_B"], "shapiro_p_B": t["shapiro_p_B"],
            "levene_F": t["levene_F"], "levene_p": t["levene_p"],
            "normality_ok": bool(t["normal_A"] and t["normal_B"]),
            "test": t["test"], "statistic_name": t["stat_name"], "statistic": t["statistic"],
            "p_value": t["p_value"], "effect_name": t["effect_name"], "effect_size": t["effect"],
            "note": t["note"],
        })
    pd.DataFrame(test_rows).to_csv(os.path.join(outdir, "assay_tests.csv"), index=False)

    # 3) figures
    dot_path = os.path.join(outdir, "assay_dotplot.png")
    sum_path = os.path.join(outdir, "assay_summary_plot.png")
    make_dotplot(df, qc, dot_path)
    make_summary_plot(res_primary, res_sens, sum_path)

    # 4) report
    report = build_report(df, qc, res_primary, res_sens, input_csv, outdir)
    md_path = os.path.join(outdir, "assay_analysis.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(report)

    print("[done] wrote:", os.path.basename(dot_path), os.path.basename(sum_path),
          "assay_summary.csv", "assay_tests.csv", "assay_analysis.md", "->", outdir)


if __name__ == "__main__":
    main()
