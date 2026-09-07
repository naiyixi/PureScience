#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
02_make_kras_figure.py
======================
Publication-grade 2-panel figure from `merged_kras_evidence.csv`
(all numeric content verified against ChEMBL / ClinicalTrials.gov /
cBioPortal-CCLE snapshots and cited PubMed abstracts at retrieval 2026-09-04).

Panel A — KRAS mutation spectrum of CCLE pancreatic-cancer cell lines
          (48 KRAS-mutated lines; cBioPortal study ccle_broad_2019).
Panel B — MRTX1133 antiproliferative activity in KRAS-mutant PDAC cell lines
          (IC50, nM, log10 x).  Measured G12D lines = filled dots; the
          reported-insensitive G12D line PANC-1 is a threshold marker (>5000).

Outputs: kras_figure.png (300 dpi) and kras_figure.svg (vector).
No DepMap Chronos value is plotted: that endpoint was unreachable at query
time (documented in the dossier), so none is shown or invented.
"""
import os

import matplotlib
import matplotlib.pyplot as plt
import pandas as pd

matplotlib.rcParams["font.family"] = "DejaVu Sans"
matplotlib.rcParams["axes.spines.top"] = False
matplotlib.rcParams["axes.spines.right"] = False

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "merged_kras_evidence.csv")
OUT_PNG = os.path.join(HERE, "kras_figure.png")
OUT_SVG = os.path.join(HERE, "kras_figure.svg")

G12D_COLOR = "#0F6BFF"      # consistent G12D colour, both panels
GREY = "#9AA3AD"
NON_G12D_COLOR = GREY

# cell-line naming map (CCLE id -> common name)
NAME = {"PANC1": "PANC-1", "ASPC1": "AsPC-1", "HPAC": "HPAC", "HPAFII": "HPAF-II",
        "MIAPACA2": "MIA PaCa-2", "HS766T": "Hs 766T", "CAPAN1": "Capan-1",
        "CAPAN2": "Capan-2", "SW1990": "SW 1990", "PL45": "PL45"}


def main() -> int:
    df = pd.read_csv(CSV)

    # ---------------- Panel A data: CCLE pancreatic KRAS subtype spectrum
    dep = df[(df.domain == "cell_line_dependency") & (df.cell_line != "(all PDAC lines)")]
    spec = dep["kras_status"].str.replace("KRAS ", "", regex=False).value_counts()
    spec = spec.sort_values(ascending=True)  # horizontal bars, smallest on top

    # ---------------- Panel B data: MRTX1133 PDAC-line cellular IC50
    resp = df[(df.domain == "cell_line_response") & (df.compound == "MRTX1133")].copy()
    resp["common"] = resp["cell_line"].map(NAME).fillna(resp["cell_line"])
    resp["measured"] = resp["relation"].isin(["=", "<", "~"])
    resp = resp.sort_values("value").reset_index(drop=True)
    # order on plot: measured lines by potency, insensitive threshold last
    resp["order"] = range(len(resp))
    # re-order: keep natural order HPAC(4.2) AsPC-1(11) HPAF-II(14.9) then PANC-1 threshold
    resp["sort_key"] = resp.apply(
        lambda r: (0 if r["measured"] else 1, r["value"]), axis=1)
    resp = resp.sort_values("sort_key").reset_index(drop=True)
    resp["row"] = range(len(resp))

    # ---------------- Figure
    fig = plt.figure(figsize=(11, 6.2), dpi=300)
    gs = fig.add_gridspec(1, 2, width_ratios=[1, 1.15], wspace=0.42,
                          left=0.075, right=0.97, top=0.80, bottom=0.21)

    # --- Panel A ---
    axA = fig.add_subplot(gs[0, 0])
    n = len(spec)
    colorsA = [G12D_COLOR if c == "G12D" else NON_G12D_COLOR for c in spec.index]
    axA.barh(range(n), spec.values, color=colorsA, edgecolor="black", linewidth=0.5, height=0.62)
    axA.set_yticks(range(n))
    axA.set_yticklabels(spec.index, fontsize=9)
    axA.set_xlabel("CCLE pancreatic KRAS-mutant cell lines (n)", fontsize=10)
    axA.set_title("A   KRAS mutation spectrum in CCLE\npancreatic cancer cell lines", fontsize=10.5, loc="left")
    for i, v in enumerate(spec.values):
        axA.text(v + 0.4, i, str(v), va="center", fontsize=9)
    axA.set_xlim(0, spec.max() + 4)
    axA.grid(axis="x", color="#E6E8EB", lw=0.6)
    axA.set_axisbelow(True)
    axA.text(0.985, 0.015,
             "source: cBioPortal ccle_broad_2019\n(48 KRAS-mutated pancreatic lines)",
             transform=axA.transAxes, ha="right", va="bottom", fontsize=7.2, color="#555555")

    # --- Panel B ---
    axB = fig.add_subplot(gs[0, 1])
    y = resp["row"].values
    x = resp["value"].values.astype(float)
    measured = resp["measured"].values
    # measured dots
    for yi, xi, m, rel in zip(y, x, measured, resp["relation"]):
        if m:
            axB.scatter([xi], [yi], s=70, color=G12D_COLOR, edgecolor="black",
                        linewidth=0.6, zorder=3)
            axB.annotate(f"{rel}{xi:g} nM", (xi, yi), textcoords="offset points",
                         xytext=(8, 0), va="center", fontsize=8.5)
        else:
            # insensitive threshold marker (>5000) for PANC-1
            axB.scatter([xi], [yi], s=80, marker="v", facecolor="white",
                        edgecolor=G12D_COLOR, linewidth=1.6, zorder=3)
            axB.annotate(f">{xi:g} nM (reported insensitive)",
                         (xi, yi), textcoords="offset points", xytext=(6, 0),
                         va="center", fontsize=8.5, color="#B03000")
    # median reference line
    axB.axvline(5, color="#444444", ls="--", lw=0.9)
    axB.text(5.6, len(resp) - 0.45, "median G12D-cell IC50 ~5 nM\n(Nat Med 2022)",
             fontsize=7.2, color="#444444", va="top")
    axB.set_xscale("log")
    axB.set_yticks(y)
    axB.set_yticklabels([f"{r['common']}  ({r['kras_status']})" for _, r in resp.iterrows()],
                        fontsize=9)
    axB.set_xlabel("MRTX1133 IC50 (nM, log scale; lower = more sensitive)", fontsize=10)
    axB.set_xlim(0.8, 60000)
    axB.set_title("B   MRTX1133 in KRAS-mutant PDAC cell lines", fontsize=10.5, loc="left")
    axB.grid(axis="x", which="both", color="#E6E8EB", lw=0.6)
    axB.set_axisbelow(True)
    # DepMap caveat footnote (data honesty)
    axB.text(0.0, -1.15,
             "DepMap Chronos gene-effect endpoint unreachable at retrieval (2026-09-04) — no gene-effect value plotted or imputed.  "
             "KRAS status per CCLE (cBioPortal).  PANC-1 = G12D yet insensitive in vitro (AJCR 2024, PMID 39417197).",
             transform=axB.get_yaxis_transform(), fontsize=7.2, color="#444444", ha="left")

    # superscript global title
    fig.suptitle("KRAS G12D inhibitors in pancreatic ductal adenocarcinoma — verified data snapshot",
                 fontsize=13, fontweight="bold", y=0.965)
    fig.text(0.075, 0.925, "Retrieval date 2026-09-04 · sources: ChEMBL, ClinicalTrials.gov, cBioPortal/CCLE, PDB, PubMed (see dossier)",
             fontsize=7.6, color="#666666")

    fig.savefig(OUT_PNG, dpi=300)
    fig.savefig(OUT_SVG)
    plt.close(fig)
    print("wrote", OUT_PNG, os.path.getsize(OUT_PNG), "bytes")
    print("wrote", OUT_SVG, os.path.getsize(OUT_SVG), "bytes")
    return 0


if __name__ == "__main__":
    main()
