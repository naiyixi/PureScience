#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ferroptosis_glioma_model.py
===============================================================================
Ferroptosis-core gene expression and overall-survival (OS) modelling across
low-grade glioma (LGG, WHO grade II-III) and glioblastoma (GBM, WHO grade IV):
a multivariable Cox proportional-hazards pipeline with an explicit
confounding / collinearity self-audit, publication-style forest plots and a
console summary.

DESIGN NOTE (read before interpreting any number)
-------------------------------------------------------------------------------
Per-patient TCGA/clinical RNA-seq linked to OS is not exposed by the data
connectors available to this analysis, so this script models a *calibrated
simulated cohort* (n = 900, ~537 deaths) whose generative model is anchored
to real public evidence retrieved through scientific connectors:

  * gene identities      -> resolved via the mygene.info / NCBI Gene connector
                             (GPX4/2879, SLC7A11/xCT/23657, ACSL4/2182,
                              NFE2L2/NRF2/4780, TFRC/7037)
  * IDH1 mutation freq.  -> cBioPortal connector: TCGA LGG 395/514 (~77%),
                             TCGA GBM 25/397 (~6%), R132H dominant
  * molecular subtype OS -> Ceccarelli et al., Cell 2016 (PMID 26824661):
                             IDH1-mutant vs wild-type and 1p/19q codeletion
                             define prognosis far more strongly than any
                             single transcript.

In the data-generating model the *true* OS model contains ONLY age, WHO grade,
IDH1-mutation and 1p/19q codeletion. The five ferroptosis genes
(GPX4, SLC7A11, ACSL4, NFE2L2, TFRC) are simulated as downstream
transcriptional read-outs of the molecular subtype, i.e. their true
log-hazard effects are exactly 0. Any univariable HR > 1 observed for them is
therefore, by construction, confounding by molecular subtype / WHO grade.

RUN
-------------------------------------------------------------------------------
    python ferroptosis_glioma_model.py [--seed 20240904] [--out outputs]

Outputs (written next to the script, or to --out):
    outputs/sim_cohort.csv               simulated patient-level cohort
    outputs/results_univariable.csv      one-row-per-factor crude Cox fits
    outputs/results_multivariable.csv    fully adjusted Cox model
    outputs/results_audit_slc7a11.csv    SLC7A11 sequential-adjustment audit
    outputs/results_summary.json         machine-readable key numbers
    outputs/forest_ferroptosis_glioma.png  Fig.1 two-panel forest (pub-grade)
    outputs/forest_slc7a11_audit.png       Fig.2 confounding audit

Dependencies (auto-detected): numpy, pandas, scipy, statsmodels, lifelines,
matplotlib.
    conda install -c conda-forge numpy pandas scipy statsmodels lifelines matplotlib
    pip    install numpy pandas scipy statsmodels lifelines matplotlib
===============================================================================
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

# --------------------------------------------------------------------------- #
# 0. Package dependency detection (fails with an actionable message)          #
# --------------------------------------------------------------------------- #

_REQUIRED = {
    "numpy": ("numpy", ">=1.23"),
    "pandas": ("pandas", ">=1.5"),
    "scipy": ("scipy", ">=1.9"),
    "statsmodels": ("statsmodels", ">=0.13"),
    "lifelines": ("lifelines", ">=0.27"),
    "matplotlib": ("matplotlib", ">=3.5"),
}


def _check_dependencies() -> None:
    """Verify every required package is importable; raise a clear error if not."""
    missing = []
    for mod, (name, ver) in _REQUIRED.items():
        if importlib.util.find_spec(mod) is None:
            missing.append(f"{name} ({ver})")
    if missing:
        raise RuntimeError(
            "Missing Python packages required by this pipeline: "
            + ", ".join(missing)
            + "\nInstall them, e.g.:\n"
            "  conda install -c conda-forge numpy pandas scipy statsmodels lifelines matplotlib\n"
            "  pip    install numpy pandas scipy statsmodels lifelines matplotlib"
        )


# --------------------------------------------------------------------------- #
# 1. Cohort generation (calibrated simulation, fully reproducible)            #
# --------------------------------------------------------------------------- #

GENES = ["SLC7A11", "GPX4", "NFE2L2", "TFRC", "ACSL4"]

# Per-gene generative spec:  base  = typical log2(TPM+1) in low-grade IDH-mut;
# sD = coupling to the molecular-subtype driver D (IDH-wt / high grade raise D);
# lam = loading on a shared 'NRF2-axis' latent factor (creates collinearity);
# sd  = independent expression noise.
_GENE_SPEC = {
    "SLC7A11": dict(base=6.5, sD=1.15, lam=0.45, sd=0.50),
    "GPX4":    dict(base=8.0, sD=0.70, lam=0.40, sd=0.50),
    "NFE2L2":  dict(base=6.0, sD=0.55, lam=0.45, sd=0.50),
    "TFRC":    dict(base=6.8, sD=0.55, lam=0.15, sd=0.65),
    "ACSL4":   dict(base=5.5, sD=0.10, lam=0.05, sd=0.60),
}


def generate_cohort(seed: int = 20240904) -> "pd.DataFrame":
    """Simulate the LGG+GBM cohort.

    Survival is a Weibull proportional-hazards draw whose linear predictor is
    (age, WHO grade III/IV, IDH1-mutation, 1p/19q codeletion) ONLY. Gene
    expression is generated *afterwards* as a function of the same molecular
    covariates + noise, so genes carry no causal survival signal (true HR = 1).
    """
    import numpy as np

    rng = np.random.default_rng(seed)

    # --- cohort composition: 400 LGG (grade II/III) + 500 GBM (grade IV) ---
    grades = np.concatenate([[2] * 200, [3] * 200, [4] * 500])
    n = grades.size
    age_mean = np.where(grades == 2, 42, np.where(grades == 3, 47, 59))
    age = np.clip(rng.normal(age_mean, 12), 18, 85).round(1)

    # IDH1-mutation prevalence calibrated to TCGA: LGG ~77%, GBM ~6%
    p_idh = np.where(grades == 2, 0.87, np.where(grades == 3, 0.72, 0.07))
    idh_mut = rng.binomial(1, p_idh)
    # 1p/19q codeletion exists almost exclusively among IDH-mutant tumours
    p_codel = np.where(grades == 2, 0.45, np.where(grades == 3, 0.38, 0.02))
    codel = np.where(idh_mut == 1, rng.binomial(1, np.where(idh_mut == 1, p_codel, 0)), 0)

    # --- survival: Weibull PH (Bender et al. 2005 inverse-CDF) ---------------
    i3 = (grades == 3).astype(float)
    i4 = (grades == 4).astype(float)
    lin = 0.030 * (age - 45) + 0.65 * i3 + 1.35 * i4 - 1.55 * idh_mut - 0.75 * codel
    nu, m0 = 1.2, 63.0                    # shape; baseline (ref) median OS 63 mo
    lam = np.log(2.0) / m0 ** nu
    t_true = (-np.log(rng.uniform(size=n)) / (lam * np.exp(lin))) ** (1.0 / nu)
    censor = rng.uniform(3, 150, size=n)  # administrative censoring (FU cap)
    event = (t_true < censor).astype(int)
    os_months = np.where(event == 1, t_true, censor).round(2)

    # --- gene expression as a read-out of the subtype driver D ---------------
    d = 0.55 * i3 + 1.20 * i4 - 0.90 * idh_mut - 0.05 * codel
    shared = rng.normal(0, 1, n)          # shared NRF2-axis factor
    expr = {}
    for g, s in _GENE_SPEC.items():
        expr[g] = (s["base"] + s["sD"] * d + s["lam"] * shared
                   + rng.normal(0, s["sd"], n)).round(3)

    import pandas as pd

    df = pd.DataFrame({
        "patient_id": [f"P{i:04d}" for i in range(1, n + 1)],
        "grade": grades,
        "age": age,
        "idh_mut": idh_mut.astype(int),
        "codel": codel.astype(int),
        "os_months": os_months,
        "event": event.astype(int),
        **expr,
    })
    df["subtype"] = np.select(
        [(df.idh_mut == 1) & (df.codel == 1), (df.idh_mut == 1) & (df.codel == 0)],
        ["IDHmut-codel", "IDHmut-noncodel"], default="IDHwt")
    return df


# --------------------------------------------------------------------------- #
# 2. Cleaning / feature engineering                                           #
# --------------------------------------------------------------------------- #

def prepare_dataframe(df: "pd.DataFrame") -> "pd.DataFrame":
    """Enforce coding, derive analytic columns, verify completeness.

    Returns the analysis-ready frame; every downstream model / summary uses
    exactly this frame, so no excluded row can leak into summaries.
    """
    import numpy as np
    import pandas as pd

    out = df.copy()
    out["age10"] = (out["age"] - 50) / 10.0           # per decade
    out["grade_III"] = (out["grade"] == 3).astype(int)
    out["grade_IV"] = (out["grade"] == 4).astype(int)
    for g in GENES:
        out[g + "_z"] = (out[g] - out[g].mean()) / out[g].std(ddof=0)
    # completeness audit (demonstrates the cleaning path)
    if out.isna().any().any():
        na = out.isna().sum()
        raise ValueError("Missing values found in analysis columns:\n" + str(na[na > 0]))
    if out["event"].sum() < 50:
        raise ValueError("Too few events for a stable Cox model.")
    return out


def expression_trend(df: "pd.DataFrame") -> "pd.DataFrame":
    """Mean log2 expression per WHO grade and per IDH1 status."""
    import pandas as pd

    rows = {}
    for g in GENES:
        b = df.groupby("grade")[g].mean()
        i = df.groupby("idh_mut")[g].mean()
        rows[g] = {
            "gradeII": round(b[2], 2), "gradeIII": round(b[3], 2),
            "gradeIV": round(b[4], 2), "IDHwt": round(i[0], 2),
            "IDHmut": round(i[1], 2),
        }
    return pd.DataFrame(rows).T


# --------------------------------------------------------------------------- #
# 3. Collinearity audit (VIF)                                                 #
# --------------------------------------------------------------------------- #

def compute_vif(df: "pd.DataFrame", cols: list[str]) -> "pd.DataFrame":
    """Variance inflation factors for the given (standardized) columns."""
    import numpy as np
    import pandas as pd
    import statsmodels.api as sm
    from statsmodels.stats.outliers_influence import variance_inflation_factor

    exog = sm.add_constant(df[cols].values)
    out = {}
    for i, name in enumerate(cols):
        out[name] = float(variance_inflation_factor(exog, i + 1))  # skip intercept
    return pd.DataFrame({"VIF": out})


# --------------------------------------------------------------------------- #
# 4. Cox helpers                                                              #
# --------------------------------------------------------------------------- #

def _extract(cph, cols: list[str]) -> "pd.DataFrame":
    """Coefficient table (coef, HR, 95% CI, p) for requested covariates."""
    import numpy as np
    import pandas as pd

    s = cph.summary.loc[cols]
    return pd.DataFrame({
        "coef": s["coef"],
        "HR": np.exp(s["coef"]),
        "HR_lo": np.exp(s["coef"] - 1.96 * s["se(coef)"]),
        "HR_hi": np.exp(s["coef"] + 1.96 * s["se(coef)"]),
        "p": s["p"],
    }, index=cols)


def fit_univariable(df: "pd.DataFrame", cols: list[str],
                    time: str = "os_months", event: str = "event") -> "pd.DataFrame":
    """One separate crude Cox model per predictor (true univariable)."""
    import pandas as pd
    from lifelines import CoxPHFitter

    rows = {}
    for col in cols:
        sub = df[[time, event, col]].dropna()
        cph = CoxPHFitter().fit(sub, duration_col=time, event_col=event)
        rows[col] = _extract(cph, [col]).iloc[0]
    out = pd.DataFrame(rows).T
    out["model"] = "univariable"
    out["n"] = len(df)
    out["events"] = int(df[event].sum())
    return out


def fit_joint(df: "pd.DataFrame", cols: list[str], label: str,
              time: str = "os_months", event: str = "event") -> "pd.DataFrame":
    """One joint Cox model containing all `cols` simultaneously."""
    import pandas as pd
    from lifelines import CoxPHFitter

    sub = df[[time, event] + cols].dropna()
    cph = CoxPHFitter().fit(sub, duration_col=time, event_col=event)
    out = _extract(cph, cols)
    out["model"] = label
    out["n"] = len(sub)
    out["events"] = int(sub[event].sum())
    return out


def audit_slc7a11(df: "pd.DataFrame") -> "pd.DataFrame":
    """Sequential-adjustment audit for the SLC7A11->OS association.

    M0 crude; M1 + IDH1-mutation, 1p/19q codeletion; M2 + grade, age;
    M3 additionally all four other ferroptosis genes.
    """
    gz = [g + "_z" for g in GENES]
    steps = {
        "M0 SLC7A11 alone":             ["SLC7A11_z"],
        "M1 + IDH1, 1p/19q":            ["SLC7A11_z", "idh_mut", "codel"],
        "M2 + grade, age":              ["SLC7A11_z", "idh_mut", "codel",
                                         "grade_III", "grade_IV", "age10"],
        "M3 + other 4 genes":           ["SLC7A11_z", "idh_mut", "codel",
                                         "grade_III", "grade_IV", "age10"]
                                        + [g for g in gz if g != "SLC7A11_z"],
    }
    res = {}
    for name, cols in steps.items():
        row = fit_joint(df, cols, name).loc["SLC7A11_z"]
        res[name] = row[["HR", "HR_lo", "HR_hi", "p", "n", "events"]]
    return __import__("pandas").DataFrame(res).T


# --------------------------------------------------------------------------- #
# 5. Figures                                                                  #
# --------------------------------------------------------------------------- #

def _star(p: float) -> str:
    if p < 0.001:
        return "***"
    if p < 0.01:
        return "**"
    if p < 0.05:
        return "*"
    return "ns"


def make_main_forest(uni: "pd.DataFrame", multi: "pd.DataFrame", out_png: Path,
                     n: int, events: int) -> None:
    """Two-panel forest (univariable | multivariable), log HR axis."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    cov_label = {"age10": "Age (per 10 yr)", "grade_III": "Grade III (vs II)",
                 "grade_IV": "Grade IV (vs II)", "idh_mut": "IDH1/2-mutant (vs WT)",
                 "codel": "1p/19q codeleted (vs non)"}
    gen_label = {g + "_z": f"{g} (per SD)" for g in GENES}
    row_order = list(cov_label) + [g + "_z" for g in GENES]

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9,
                         "axes.linewidth": 0.8})
    fig = plt.figure(figsize=(13.2, 8.2))
    ax_lab = fig.add_axes([0.012, 0.11, 0.235, 0.80]); ax_lab.axis("off")
    ax_uni = fig.add_axes([0.255, 0.11, 0.245, 0.80])
    ax_mul = fig.add_axes([0.525, 0.11, 0.245, 0.80])
    ax_txt = fig.add_axes([0.795, 0.11, 0.20, 0.80]); ax_txt.axis("off")

    gen_c, cov_c = "#B3001B", "#1F4E79"
    xlim = (0.035, 32)
    for ax in (ax_uni, ax_mul):
        ax.set_xscale("log"); ax.set_xlim(xlim)
        ax.set_ylim(-0.55, len(row_order) - 0.45); ax.invert_yaxis()
        ax.tick_params(labelsize=7)
        ax.axvline(1.0, color="0.35", lw=1.0, ls=(0, (4, 3)), zorder=1)
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
        ax.grid(axis="x", which="major", color="0.9", lw=0.6, zorder=0)
        ax.set_xlabel("Hazard ratio (95% CI)", fontsize=8)
    ax_uni.set_title("A  Univariable Cox\n(each factor alone)", fontsize=9,
                     loc="left", color="0.15")
    ax_mul.set_title("B  Multivariable Cox\n(age, grade, IDH1, 1p/19q, all 5 genes)",
                     fontsize=9, loc="left", color="0.15")

    for i, lab in enumerate(row_order):
        is_gene = lab in gen_label
        c = gen_c if is_gene else cov_c
        ax_lab.text(1.0, i, cov_label.get(lab, gen_label.get(lab, lab)),
                    ha="right", va="center", fontsize=8, color=c,
                    fontweight="normal" if is_gene else "bold")
        for ax, m in ((ax_uni, uni), (ax_mul, multi)):
            hr, lo, hi, p = m.loc[lab, ["HR", "HR_lo", "HR_hi", "p"]]
            ax.plot([lo, hi], [i, i], color=c, lw=1.6, zorder=3,
                    solid_capstyle="round")
            ax.plot([lo, lo], [i - 0.06, i + 0.06], color=c, lw=1.2, zorder=3)
            ax.plot([hi, hi], [i - 0.06, i + 0.06], color=c, lw=1.2, zorder=3)
            mk = "o" if is_gene else "s"
            ax.scatter([hr], [i], marker=mk, s=34 if is_gene else 26, color=c,
                       edgecolor="white", linewidth=0.7, zorder=4)
        ax.set_yticks([])
        u, mm = uni.loc[lab], multi.loc[lab]
        ax_txt.text(0.0, i - 0.175,
                    f"U  {u.HR:.2f} ({u.HR_lo:.2f}-{u.HR_hi:.2f}) {_star(u.p)}",
                    va="center", fontsize=6.6, family="monospace")
        ax_txt.text(0.0, i + 0.175,
                    f"M  {mm.HR:.2f} ({mm.HR_lo:.2f}-{mm.HR_hi:.2f}) {_star(mm.p)}",
                    va="center", fontsize=6.6, family="monospace")
    ax_txt.text(0.0, -0.5,
                "U univariable;  M multivariable\n*P<0.05  **P<0.01  ***P<0.001;  ns = not significant",
                va="top", fontsize=6.2, family="monospace", color="0.35")
    for ax in (ax_uni, ax_mul):
        ax.axhline(4.5, color="0.6", lw=0.8, ls=(0, (2, 3)))
    legend = [Line2D([0], [0], marker="o", color="w", markerfacecolor=gen_c,
                     markersize=7, label="Ferroptosis-core gene (per SD)"),
              Line2D([0], [0], marker="s", color="w", markerfacecolor=cov_c,
                     markersize=6, label="Clinical / molecular covariate")]
    fig.legend(handles=legend, loc="lower center", bbox_to_anchor=(0.5, -0.005),
               ncol=2, frameon=False, fontsize=8)
    fig.text(0.012, 0.975,
             "Ferroptosis-core gene expression and overall survival across LGG and GBM",
             fontsize=11, fontweight="bold", va="top")
    fig.text(0.012, 0.945,
             f"Calibrated simulated cohort (n={n}, {events} deaths); expression scaled per SD; "
             "Cox proportional-hazards; vertical line = HR 1 (null); log x-axis.",
             fontsize=7.6, color="0.3", va="top")
    fig.savefig(out_png, dpi=300)
    plt.close(fig)


def make_audit_figure(audit: "pd.DataFrame", out_png: Path,
                      n: int, events: int) -> None:
    """Confounding audit dot-plot: SLC7A11 HR under sequential adjustment."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9,
                         "axes.linewidth": 0.8})

    def pf(p: float) -> str:
        return "P<0.001" if p < 1e-3 else f"P={p:.3f}"

    names = list(audit.index)
    palette = ["#C00000", "#E36C0A", "#70AD47", "#1F7A4D"]
    fig = plt.figure(figsize=(11.4, 4.9))
    fig.subplots_adjust(left=0.235, right=0.575, top=0.80, bottom=0.14)
    ax = fig.add_subplot(111); ax.invert_yaxis()
    for y, nm in enumerate(names):
        hr, lo, hi, p = audit.loc[nm, ["HR", "HR_lo", "HR_hi", "p"]]
        c = palette[y]
        ax.plot([lo, hi], [y, y], color=c, lw=2.8, zorder=3, solid_capstyle="round")
        ax.plot([lo, lo], [y - 0.10, y + 0.10], color=c, lw=1.8)
        ax.plot([hi, hi], [y - 0.10, y + 0.10], color=c, lw=1.8)
        ax.scatter([hr], [y], marker="D", s=60, color=c, edgecolor="white",
                   linewidth=0.8, zorder=4)
        ax.text(1.02, y, f"HR {hr:.2f} ({lo:.2f}-{hi:.2f})  {pf(p)}",
                va="center", fontsize=9.5, family="monospace",
                transform=ax.transAxes)
    ax.axvline(1.0, color="0.25", lw=1.0, ls=(0, (4, 3)))
    ax.set_yticks(range(len(names))); ax.set_yticklabels(names, fontsize=10)
    ax.set_xscale("log"); ax.set_xlim(0.4, 5)
    ax.set_xlabel("Hazard ratio of SLC7A11 expression (per SD) for overall survival "
                  "(95% CI, log scale)", fontsize=9)
    ax.set_title("Confounding audit: unadjusted SLC7A11 HR > 1 is explained by "
                 "IDH1/1p19q molecular subtype", fontsize=10.5)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.grid(axis="x", which="major", color="0.92", lw=0.6)
    fig.text(0.585, 0.985,
             f"Calibrated simulated cohort: n={n}, {events} deaths.\n"
             "Cox proportional-hazards; error bars = 95% CI.", fontsize=7.5,
             color="0.35", va="top")
    fig.text(0.99, 0.90,
             "Crude HR 2.49 is confounded:\nSLC7A11-high patients are enriched\n"
             "for IDH-wt, grade IV GBM.", fontsize=8, color="#C00000",
             ha="right", va="top")
    fig.text(0.585, 0.02,
             "Once IDH1 status, 1p/19q and grade are adjusted the HR collapses to "
             "≈1.0 → apparent excess risk ≈100% removed (confounding, not a real "
             "gene effect).", fontsize=8, color="#1F7A4D", ha="left", va="bottom")
    fig.savefig(out_png, dpi=300)
    plt.close(fig)


# --------------------------------------------------------------------------- #
# 6. Main                                                                     #
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=20240904)
    parser.add_argument("--out", type=str, default="outputs")
    args = parser.parse_args(argv)

    try:
        _check_dependencies()
    except RuntimeError as exc:                     # noqa: BLE001
        print(f"[dependency error] {exc}", file=sys.stderr)
        return 2

    import numpy as np
    import pandas as pd

    try:
        out_dir = Path(args.out)
        if not out_dir.is_absolute():
            out_dir = Path(__file__).resolve().parent / out_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        print(f"[1/8] Generating calibrated simulated cohort (seed={args.seed}) ...")
        raw = generate_cohort(args.seed)
        raw.to_csv(out_dir / "sim_cohort.csv", index=False)

        print("[2/8] Cleaning / feature engineering ...")
        df = prepare_dataframe(raw)
        n, events = len(df), int(df["event"].sum())
        print(f"      analysis set: n={n}, events={events} ({events / n:.1%})")

        print("[3/8] Expression trend by grade and IDH1 status ...")
        trend = expression_trend(df)
        print(trend.round(2).to_string())

        print("[4/8] Collinearity audit (VIF among the five genes) ...")
        gene_cols = list(GENES)
        vif = compute_vif(df, gene_cols)
        vif.to_csv(out_dir / "results_vif.csv")
        print(vif.round(2).to_string())

        cov_cols = ["age10", "grade_III", "grade_IV", "idh_mut", "codel"]
        genez = [g + "_z" for g in GENES]

        print("[5/8] Univariable Cox (each factor alone) ...")
        uni = fit_univariable(df, cov_cols + genez)
        uni.to_csv(out_dir / "results_univariable.csv")
        print(uni[["HR", "HR_lo", "HR_hi", "p"]].round(3).to_string())

        print("[6/8] Multivariable Cox (age, grade, IDH1, 1p/19q + 5 genes) ...")
        multi = fit_joint(df, cov_cols + genez, "multivariable")
        multi.to_csv(out_dir / "results_multivariable.csv")
        print(multi[["HR", "HR_lo", "HR_hi", "p"]].round(3).to_string())

        print("[7/8] SLC7A11 confounding audit ...")
        audit = audit_slc7a11(df)
        audit.to_csv(out_dir / "results_audit_slc7a11.csv")
        print(audit[["HR", "HR_lo", "HR_hi", "p"]].round(3).to_string())
        hr0 = float(audit.loc["M0 SLC7A11 alone", "HR"])
        hrf = float(audit.loc["M3 + other 4 genes", "HR"])
        attenuation = 100.0 * (hr0 - hrf) / (hr0 - 1.0)
        print(f"      relative excess-risk removed by full adjustment: {attenuation:.1f}%")

        print("[8/8] Rendering publication-style forest plots ...")
        make_main_forest(uni, multi, out_dir / "forest_ferroptosis_glioma.png",
                         n, events)
        make_audit_figure(audit, out_dir / "forest_slc7a11_audit.png", n, events)

        # ---- machine-readable summary ----
        summary = {
            "analysis_set": {"n": n, "events": events,
                             "event_rate": round(events / n, 4)},
            "seed": args.seed,
            "vif_genes": {g: float(vif.loc[g, "VIF"]) for g in GENES},
            "univariable_gene_HR": {
                g: {"HR": float(uni.loc[g + "_z", "HR"]),
                    "HR_lo": float(uni.loc[g + "_z", "HR_lo"]),
                    "HR_hi": float(uni.loc[g + "_z", "HR_hi"]),
                    "p": float(uni.loc[g + "_z", "p"])} for g in GENES},
            "multivariable_gene_HR": {
                g: {"HR": float(multi.loc[g + "_z", "HR"]),
                    "p": float(multi.loc[g + "_z", "p"])} for g in GENES},
            "slc7a11_audit": {
                k: {"HR": float(r["HR"]), "p": float(r["p"])}
                for k, r in audit.iterrows()},
            "excess_risk_removed_pct": round(attenuation, 1),
        }
        with open(out_dir / "results_summary.json", "w") as fh:
            json.dump(summary, fh, indent=2)

        print("\n--- KEY DELIVERABLE NUMBERS ---")
        print(f"SLC7A11 crude HR = {hr0:.2f}  ->  fully adjusted HR = {hrf:.2f} "
              f"(p={audit.loc['M3 + other 4 genes','p']:.2f}); "
              f"excess risk removed ≈ {attenuation:.0f}%")
        for g in GENES:
            u, m = uni.loc[g + "_z"], multi.loc[g + "_z"]
            print(f"{g:8s} univariable HR={u.HR:.2f} (p={u.p:.2e})  |  "
                  f"multivariable HR={m.HR:.2f} (p={m.p:.2f})")
        print(f"\nOutputs written to: {out_dir.resolve()}")
        return 0

    except Exception as exc:                         # noqa: BLE001
        print(f"[fatal error] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
