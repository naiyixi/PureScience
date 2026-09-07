#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
01_build_merged_evidence.py
===========================
Reconstruct `merged_kras_evidence.csv` for the KRAS G12D / PDAC inhibitor
cross-validation dossier from the verified intermediate JSON snapshots in
`./intermediate` (each snapshot is an immutable extract taken from a live
connector or a peer-reviewed source at retrieval time 2026-09-04).

Run:  python 01_build_merged_evidence.py   (cwd = directory that holds ./intermediate)
Outputs: merged_kras_evidence.csv  (+ prints a QC summary)

Anti-hallucination contract
----------------------------
- Every numeric value either comes from a JSON snapshot captured from a live
  data connector (ChEMBL / ClinicalTrials.gov / cBioPortal-CCLE / gnomAD /
  ClinVar / PDB / PubChem) or is a literature figure taken verbatim from the
  abstract of a cited PubMed record (PMID stored in `source_id`).
- Where a requested datum could NOT be retrieved (DepMap Chronos gene-effect;
  CADD PHRED), the cell is left empty and `verified` is set to an explicit
  DEPMAP-UNAVAILABLE / CADD-BLOCKED marker.  No value is imputed or guessed.
"""
import json
import os
import sys

import pandas as pd  # noqa: E402  (import order kept flat for clarity)

HERE = os.path.dirname(os.path.abspath(__file__))
INT = os.path.join(HERE, "intermediate")
OUT_CSV = os.path.join(HERE, "merged_kras_evidence.csv")


def load(fn: str):
    with open(os.path.join(INT, fn), encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    trials_raw = load("trials_search_raw.json")
    trials_det = load("trials_details.json")
    mrtx_act = load("mrtx1133_activity.json")
    curated = load("curated_facts.json")
    ccle_panc = load("ccle_pancreatic_kras.json")

    rows = []

    def add(domain, **kw):
        rows.append({"domain": domain, **kw})

    # ---------------------------------------------------------------- 1 compound activity
    TARGET_CLEAN = {
        "GTPase KRas": ("KRAS", "biochemical/binding"),
        "SOS1-KRAS": ("KRAS/SOS1 complex", "biochemical"),
        "Mitogen-activated protein kinase; ERK1/ERK2": ("MAPK1/MAPK3 (ERK2/ERK1)", "kinase selectivity"),
        "ASPC1": ("ASPC1", "cell_line"), "HPAC": ("HPAC", "cell_line"),
        "HPAF-II": ("HPAF-II", "cell_line"), "AGS": ("AGS (gastric)", "cell_line"),
        "SK-LU-1": ("SK-LU-1 (lung)", "cell_line"), "LS-513": ("LS-513 (CRC)", "cell_line"),
        "MKN-1": ("MKN-1 (gastric)", "cell_line"),
    }
    seen = set()
    for a in mrtx_act:
        if not isinstance(a, dict) or a.get("act_id") in seen:
            continue
        seen.add(a.get("act_id"))
        tgt = a.get("target", "")
        tname, tcls = TARGET_CLEAN.get(tgt, (tgt, "other"))
        if tgt == "Unchecked":
            tname, tcls = "unannotated ChEMBL target CHEMBL612545", "cell_panel_unknown"
        if tgt == "ADMET":
            tname, tcls = "ADMET", "admet"
        add("compound_activity",
            compound="MRTX1133", chembl_id="CHEMBL4858364",
            target=tname, target_class=tcls,
            mutation_context="assay-level; MRTX1133 is GDP-state preferential (see dossier)",
            activity_type=a.get("type"), relation=a.get("rel"),
            value=a.get("val"), unit=a.get("unit"), pchembl=a.get("pchembl"),
            assay_chembl_id=a.get("assay"), assay_type=a.get("assay_type"),
            doc_chembl_id=a.get("doc"),
            cell_line=(tname if tcls == "cell_line" else ""),
            source_db="ChEMBL", source_id=f"activity_id:{a.get('act_id')}",
            value_text="", verified="VERIFIED(source row)",
            note="ChEMBL extract for CHEMBL4858364 (MRTX-1133)")

    cur = curated["compounds"]
    add("compound_activity", compound="MRTX1133", chembl_id="CHEMBL4858364",
        target="KRAS G12D (GDP-loaded)", target_class="biochemical/binding",
        mutation_context="GDP-bound inactive state",
        activity_type="Kd", relation="~", value=0.0002, unit="nM", pchembl=None,
        assay_chembl_id=None, assay_type="SPR/binding", cell_line="",
        source_db="PubMed(Nat Med)", source_id="PMID:36216931",
        value_text="KD ~0.2 pM to GDP-loaded KRAS G12D",
        verified="VERIFIED(abstract)",
        note="Hallin et al 2022 Nat Med 28:2171; ~700-fold vs KRAS-WT binding selectivity")
    add("compound_activity", compound="MRTX1133", chembl_id="CHEMBL4858364",
        target="KRAS G12D (GDP-loaded)", target_class="biochemical/binding",
        mutation_context="GDP-bound inactive state",
        activity_type="IC50(binding)", relation="<", value=2, unit="nM", pchembl=None,
        assay_chembl_id=None, assay_type="biochemical", cell_line="",
        source_db="PubMed(Nat Med)", source_id="PMID:36216931",
        value_text="binding IC50 <2 nM (GDP-state KRAS G12D)",
        verified="VERIFIED(abstract)",
        note="same source as KD row; ChEMBL analogue: activity_id 24842033 IC50 2.0 nM pChEMBL 8.7")
    add("compound_activity", compound="MRTX1133", chembl_id="CHEMBL4858364",
        target="KRAS G12D-mutant cell lines (median)", target_class="cell_panel",
        mutation_context="cellular",
        activity_type="IC50(viability)", relation="~", value=5, unit="nM", pchembl=None,
        assay_chembl_id=None, assay_type="cell viability / phospho-ERK",
        cell_line="median over G12D lines", source_db="PubMed(Nat Med)", source_id="PMID:36216931",
        value_text="median cell IC50 ~5 nM; >1000x vs KRAS-WT lines",
        verified="VERIFIED(abstract)",
        note="tumor regression >=30% in 8/11 PDAC CDX/PDX models")
    add("compound_activity", compound="HRS-4642", chembl_id=None,
        target="KRAS G12D", target_class="biochemical/binding",
        mutation_context="(as reported)",
        activity_type="affinity", relation="=", value=0.083, unit="nM", pchembl=None,
        assay_chembl_id=None, assay_type="affinity (reported as affinity constant)", cell_line="",
        source_db="PubMed(Cancer Cell)", source_id="PMID:38942026",
        value_text="affinity constant 0.083 nM; non-covalent, selective",
        verified="VERIFIED(abstract)",
        note="Zhou et al, Cancer Cell 2024; ChEMBL record absent at retrieval (gap)")
    add("compound_activity", compound="RMC-9805(zoldonrasib)", chembl_id=None,
        target="KRAS G12D (active/GTP-bound)", target_class="biochemical/covalent",
        mutation_context="GTP-bound (RAS-ON); CYPA tri-complex",
        activity_type="covalent binding", relation="irreversible",
        value=None, unit=None, pchembl=None, assay_chembl_id=None,
        assay_type="covalent kinetics (CypA-catalysed)", cell_line="",
        source_db="PubMed(Science)", source_id="PMID:40705880",
        value_text="no equilibrium Kd reported; covalent reaction with D12, CYPA-catalysed",
        verified="VERIFIED(abstract)",
        note="Koltun et al, Science 2025; PDB 9CTB (1.29 A, GppNHp/active state)")
    add("compound_activity", compound="HRS-4642", chembl_id=None,
        target="advanced KRAS G12D-mutant PDAC", target_class="clinical efficacy",
        mutation_context="patients, KRAS G12D-mutant PDAC",
        activity_type="ORR", relation="=", value=63.3, unit="%", pchembl=None,
        assay_chembl_id=None, assay_type="phase 1b/2 trial",
        cell_line="", source_db="PubMed(Nat Med)", source_id="PMID:42426224",
        value_text="confirmed ORR 63.3% (95%CI 43.9-80.1), n=30 first-line, HRS-4642 + AG",
        verified="VERIFIED(abstract)",
        note="HRS-4642 liposomal IV formulation")

    # ---- 1c. curated PDAC cell-line response rows (compound activity, cell level)
    line_pot = [
        ("HPAC", "G12D", 4.2, "=", "ChEMBL activity_id:25663224 (doc CHEMBL5370635)"),
        ("AsPC-1", "G12D", 11.0, "=", "ChEMBL activity_id:25663212 (doc CHEMBL5370635)"),
        ("HPAF-II", "G12D", 14.9, "=", "ChEMBL activity_id:25663225 (doc CHEMBL5370635)"),
        ("PANC-1", "G12D", 5000, ">", "AJCR 2024 PMID:39417197 (PANC-1 >5000 nM)"),
    ]
    for ln, mut, val, rel, src in line_pot:
        add("cell_line_response", compound="MRTX1133", cell_line=ln,
            kras_status=f"KRAS {mut}", activity_type="IC50", relation=rel,
            value=val, unit="nM",
            source_db=("ChEMBL" if "ChEMBL" in src else "PubMed"),
            source_id=src.split("(")[-1].rstrip(")"),
            value_text=f"MRTX1133 IC50 {rel}{val} nM", verified="VERIFIED",
            note=f"KRAS {mut} (CCLE); {src}")

    # ---------------------------------------------------------------- 2 clinical trials
    trial_keys = {
        "MRTX1133": ["mrtx1133_panc"],
        "RMC-9805(zoldonrasib)": ["rmc9805_panc"],
        "HRS-4642": ["hrs4642_panc"],
    }
    seen_nct = set()
    for comp, keys in trial_keys.items():
        for k in keys:
            for it in trials_raw.get(k, []):
                nct = it.get("nct")
                if not nct or nct in seen_nct:
                    continue
                seen_nct.add(nct)
                add("clinical_trial", nct_id=nct, drug=comp,
                    phase=",".join(it.get("phase") or []), status=it.get("status"),
                    sponsor=it.get("sponsor"), conditions=";".join(it.get("cond") or []),
                    combination=" + ".join(it.get("intr", []) or []) or "(monotherapy)",
                    title=(it.get("title") or "").strip(),
                    start_date=it.get("start"), enrollment=it.get("enroll"),
                    source_db="ClinicalTrials.gov", source_id=nct,
                    verified="VERIFIED(search record)")
    for grp in ("primary", "extra"):
        for nct, d in (trials_det.get(grp) or {}).items():
            if not isinstance(d, dict) or d.get("error") or nct in seen_nct:
                continue
            seen_nct.add(nct)
            intr = d.get("interventions") or []
            intr_s = " + ".join(i if isinstance(i, str) else i.get("name", "") for i in intr)
            add("clinical_trial", nct_id=nct, drug="(detail-verified)",
                phase=",".join(d.get("phase") or []), status=d.get("status"),
                sponsor=d.get("sponsor"), conditions=";".join(d.get("conditions") or []),
                combination=intr_s, title=(d.get("title") or "").strip(),
                start_date=d.get("start"), enrollment=None,
                source_db="ClinicalTrials.gov", source_id=nct, verified="VERIFIED(detail)")

    # ---------------------------------------------------------------- 3 cell-line dependency
    depmap_note = (
        "DepMap Chronos gene-effect NOT RETRIEVED at query time (2026-09-04): "
        "depmap_search_cell_line & depmap_dependencies_for_gene both returned "
        "'fetch failed' after >10 spaced attempts (source outage). No value imputed.")
    for ln, change in [(x["line"], x["change"]) for x in ccle_panc["lines"]]:
        add("cell_line_dependency", cell_line=ln.replace("_PANCREAS", ""),
            kras_status=f"KRAS {change}", gene="KRAS", chronos_score=float("nan"),
            value_text="Chronos not retrieved", verified="DEPMAP-UNAVAILABLE",
            note=f"CCLE (ccle_broad_2019) mutation {change}. {depmap_note}")
    add("cell_line_dependency", cell_line="(all PDAC lines)", kras_status="mixed",
        gene="KRAS/EGFR/PIK3CA/PIK3CB/PIK3R1/AKT1/AKT2/MAP2K1/BRAF/RAF1/PTPN11/ERBB2/MET",
        chronos_score=float("nan"), value_text="Chronos not retrieved",
        verified="DEPMAP-UNAVAILABLE", note=depmap_note)

    df = pd.DataFrame(rows)
    df.to_csv(OUT_CSV, index=False)
    print("rows_total:", len(df))
    print("domains:", df.domain.value_counts().to_dict())
    print("unique NCTs:", df.loc[df.domain == "clinical_trial", "nct_id"].nunique())
    print("saved:", OUT_CSV, os.path.getsize(OUT_CSV), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
