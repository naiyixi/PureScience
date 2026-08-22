#!/usr/bin/env python3
"""Regenerate kras_structures.csv and kras_structures_comparison.png from the fetched
RCSB PDB metadata (kras_data.json).

Usage:
    python build_kras_structures.py [input.json] [output_dir]
Defaults: input from $PURESCIENCE_HANDOFF_DIR/kras_data.json (or ./kras_data.json);
outputs written to the current directory.
"""
import json, os, sys
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

def build_row(r):
    return {
        "pdb_id": r["pdb_id"],
        "title": r["title"],
        "experimental_method": "; ".join(r["experimental_methods"]),
        "resolution_angstrom": r["resolution_angstrom"],
        "polymer_chain_count": r["polymer_chain_count"],
        "polymer_entity_count": r["polymer_entity_count"],
        "nonpolymer_entity_count": r["nonpolymer_entity_count"],
        "ligand_comp_ids": "; ".join(r["ligand_comp_ids"]),
        "ligand_summary": r["ligand_summary"],
        "deposit_date": r["deposit_date"],
        "initial_release_date": r["initial_release_date"],
        "source_organism": r["organism"],
        "uniprot_ids": r["uniprot_ids"],
        "mutation_count": r["mutation_count"],
        "molecular_weight_kda": r["molecular_weight_kda"],
        "structure_determination_methodology": r["methodology"],
        "comparable_in_kras_comparison": r["comparable"],
        "notes": r["notes"],
    }

def main():
    handoff = os.environ.get("PURESCIENCE_HANDOFF_DIR")
    src = sys.argv[1] if len(sys.argv) > 1 else (
        os.path.join(handoff, "kras_data.json") if handoff else "kras_data.json")
    out = sys.argv[2] if len(sys.argv) > 2 else "."
    with open(src) as f:
        data = json.load(f)

    df = pd.DataFrame([build_row(r) for r in data["rows"]])
    df = df.set_index("pdb_id").loc[["4OBE", "6OIM", "8E8X"]].reset_index()
    csv_path = os.path.join(out, "kras_structures.csv")
    df.to_csv(csv_path, index=False)

    order = ["4OBE", "6OIM", "8E8X"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 5))

    ax = axes[0]
    for pid in order:
        row = df[df["pdb_id"] == pid].iloc[0]
        if row["comparable_in_kras_comparison"]:
            ax.bar(pid, row["resolution_angstrom"], color="#1f77b4", width=0.55)
        else:
            ax.bar(pid, row["resolution_angstrom"], color="#b0b0b0", hatch="///", width=0.55)
    ax.set_ylabel("Reported resolution (A)")
    ax.set_title("(a) Resolution")
    for i, pid in enumerate(order):
        v = df[df["pdb_id"] == pid].iloc[0]["resolution_angstrom"]
        ax.text(i, v + 0.03, f"{v:.2f}", ha="center", va="bottom", fontsize=9)

    ax = axes[1]
    for pid in order:
        row = df[df["pdb_id"] == pid].iloc[0]
        if row["comparable_in_kras_comparison"]:
            ax.bar(pid, row["polymer_chain_count"], color="#1f77b4", width=0.55)
        else:
            ax.bar(pid, row["polymer_chain_count"], color="#b0b0b0", hatch="///", width=0.55)
    ax.set_ylabel("Polymer chains (deposited copies)")
    ax.set_title("(b) Number of polymer chains")
    for i, pid in enumerate(order):
        v = df[df["pdb_id"] == pid].iloc[0]["polymer_chain_count"]
        ax.text(i, v + 0.05, str(v), ha="center", va="bottom", fontsize=9)

    handles = [
        Patch(facecolor="#1f77b4", label="Comparable KRAS structures (X-ray; included in summary stats)"),
        Patch(facecolor="#b0b0b0", hatch="///",
              label="8E8X - retrieved but NOT a human KRAS structure (poliovirus 3 + Fab); excluded from comparison"),
    ]
    fig.legend(handles=handles, loc="lower center", ncol=1, fontsize=8, frameon=True,
               bbox_to_anchor=(0.5, -0.03))
    fig.suptitle(f"Human KRAS PDB structures 4OBE, 6OIM and the retrieved-but-excluded entry 8E8X\n"
                 f"Data: RCSB PDB (retrieved {data['request_date']})", fontsize=11)
    fig.tight_layout(rect=[0, 0.12, 1, 0.94])
    png_path = os.path.join(out, "kras_structures_comparison.png")
    fig.savefig(png_path, dpi=160, bbox_inches="tight")
    print("wrote:", csv_path)
    print("wrote:", png_path)

if __name__ == "__main__":
    main()
