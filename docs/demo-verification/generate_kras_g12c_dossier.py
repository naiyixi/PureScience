#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_kras_g12c_dossier.py
-----------------------------
根据 PureScience 连接器收集的 KRAS G12C 抑制剂数据（JSON），生成：
  1. kras_g12c_inhibitors.csv  — 候选化合物 / IC50 / 试验 / 文献 汇总表
  2. kras_g12c_ic50.png        — 前 5 候选的 IC50 条形图（标注单位与坐标尺度）

用法:
  python generate_kras_g12c_dossier.py <input_dataset.json> [output_dir]

数据来源全部由连接器核实（ChEMBL / ClinicalTrials.gov / PubMed），
本脚本只做本地格式化为 CSV / 图表，不补充任何数据。
"""
import sys
import os
import json
import csv

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm

# 注册系统中文字体，避免图表中文缺字
_CJK_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
]
for _fp in _CJK_FONT_CANDIDATES:
    if os.path.exists(_fp):
        try:
            fm.fontManager.addfont(_fp)
            plt.rcParams["font.family"] = fm.FontProperties(fname=_fp).get_name()
            break
        except Exception:
            continue
plt.rcParams["axes.unicode_minus"] = False

import pandas as pd


def load_dataset(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def build_rows(ds):
    rows = []
    for c in ds["candidates"]:
        papers = c.get("papers", []) or []
        t = c.get("trial") or {}
        p1 = papers[0] if len(papers) > 0 else {}
        p2 = papers[1] if len(papers) > 1 else {}
        name = c.get("compound_name")
        if name is None:
            name = "N/A (ChEMBL 无首选名)"
        rows.append({
            "rank": c.get("rank"),
            "compound_name": name,
            "molecule_chembl_id": c.get("molecule_chembl_id"),
            "parent_molecule_chembl_id": c.get("parent_molecule_chembl_id"),
            "ic50_value": c.get("ic50_nM"),
            "ic50_unit": "nM",
            "pchembl_value": c.get("pchembl_value"),
            "activity_id": c.get("activity_id"),
            "assay_chembl_id": c.get("assay_chembl_id"),
            "assay_type": c.get("assay_type"),
            "assay_variant_mutation": c.get("assay_variant_mutation"),
            "assay_description": c.get("assay_description"),
            "document_chembl_id": c.get("document_chembl_id"),
            "document_journal": c.get("document_journal"),
            "document_year": c.get("document_year"),
            "smiles": c.get("smiles"),
            # ClinicalTrials.gov（突变/适应症层面匹配）
            "trial_nct_id": t.get("nct", "未找到"),
            "trial_phase": t.get("phase", ""),
            "trial_status": t.get("status", ""),
            "trial_sponsor": t.get("sponsor", ""),
            "trial_intervention": t.get("intervention", ""),
            "trial_condition": t.get("condition", ""),
            "trial_match_level": "indication/mutation-level (candidate unnamed)",
            # PubMed
            "paper1_pmid": p1.get("pmid", ""),
            "paper1_title": p1.get("title", ""),
            "paper1_journal": p1.get("journal", ""),
            "paper1_year": p1.get("year", ""),
            "paper1_doi": p1.get("doi", ""),
            "paper1_kind": p1.get("kind", ""),
            "paper2_pmid": p2.get("pmid", ""),
            "paper2_title": p2.get("title", ""),
            "paper2_journal": p2.get("journal", ""),
            "paper2_year": p2.get("year", ""),
            "paper2_doi": p2.get("doi", ""),
            "paper2_kind": p2.get("kind", ""),
        })
    return rows


def write_csv(rows, out_csv):
    cols = [
        "rank", "compound_name", "molecule_chembl_id", "parent_molecule_chembl_id",
        "ic50_value", "ic50_unit", "pchembl_value", "activity_id",
        "assay_chembl_id", "assay_type", "assay_variant_mutation", "assay_description",
        "document_chembl_id", "document_journal", "document_year", "smiles",
        "trial_nct_id", "trial_phase", "trial_status", "trial_sponsor",
        "trial_intervention", "trial_condition", "trial_match_level",
        "paper1_pmid", "paper1_title", "paper1_journal", "paper1_year", "paper1_doi", "paper1_kind",
        "paper2_pmid", "paper2_title", "paper2_journal", "paper2_year", "paper2_doi", "paper2_kind",
    ]
    df = pd.DataFrame(rows, columns=cols)
    df.to_csv(out_csv, index=False, encoding="utf-8-sig")
    return len(df)


def write_png(rows, out_png, meta):
    data = sorted(rows, key=lambda r: r["ic50_value"], reverse=True)  # 最小值在底部
    labels = [f"{r['molecule_chembl_id']}\n(r{r['rank']})" for r in data]
    vals = [float(r["ic50_value"]) for r in data]
    pchembl = [float(r["pchembl_value"]) for r in data]

    fig, ax = plt.subplots(figsize=(9, 5.2), dpi=150)
    bars = ax.barh(labels, vals, color="#3b6ea5", edgecolor="black", alpha=0.9, height=0.6)

    for b, v, pc in zip(bars, vals, pchembl):
        ax.text(b.get_width() + 0.02, b.get_y() + b.get_height() / 2,
                f"{v:.2f} nM   (pChEMBL {pc:.2f})", va="center", fontsize=9)

    ax.set_xlabel("IC50 (nM)  —  线性坐标 (linear scale, 未使用对数坐标)", fontsize=10)
    ax.set_ylabel("候选化合物 (ChEMBL ID)", fontsize=10)
    ax.set_title("KRAS G12C 抑制剂候选 — ChEMBL 报告 IC50（前 5，按数值升序）", fontsize=12, fontweight="bold")
    ax.set_xlim(0, max(vals) * 1.35)
    ax.grid(axis="x", linestyle="--", alpha=0.4)

    note = (f"数据源: ChEMBL 靶点 {meta.get('chembl_target', '')} ({meta.get('chembl_target_name', '')})\n"
            f"单位: nM; IC50 均为明确值 (standard_relation '='); 候选按 IC50 升序取前 5\n"
            f"生成: {meta.get('generated', '')} | 连接器: PureScience ChEMBL")
    fig.text(0.01, 0.01, note, fontsize=8, color="#444444", va="bottom", ha="left")
    fig.tight_layout(rect=[0, 0.07, 1, 1])
    fig.savefig(out_png)
    plt.close(fig)


def main():
    if len(sys.argv) < 2:
        print("usage: python generate_kras_g12c_dossier.py <dataset.json> [output_dir]", file=sys.stderr)
        return 1
    ds_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    os.makedirs(out_dir, exist_ok=True)

    ds = load_dataset(ds_path)
    rows = build_rows(ds)

    out_csv = os.path.join(out_dir, "kras_g12c_inhibitors.csv")
    out_png = os.path.join(out_dir, "kras_g12c_ic50.png")

    n = write_csv(rows, out_csv)
    write_png(rows, out_png, ds.get("meta", {}))

    print(f"[ok] {out_csv}  ({n} 行)")
    print(f"[ok] {out_png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
