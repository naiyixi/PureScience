#!/usr/bin/env python3
"""Large omics file preview (h5ad / VCF) — probe structure before loading data.

Emits an OmicsPreviewManifest JSON (schemaVersion 1) consumed by
src/shared/omics-preview.ts. Read-only by construction; dependency-free for VCF.

Iron rules (see SKILL.md):
  * G6 — a downsampled read must carry its subset info so the app can label it.
  * G1 — full-data answers go through the compute ladder, never a preview conclusion.
  * Never guess: unknown structure is reported as unknown with full_run_required=True.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = 1
DEFAULT_SUBSET_CELLS = 2000
DEFAULT_MAX_VARIANTS = 50000


def detect_format(path: str) -> str:
    lowered = path.strip().lower()
    if lowered.endswith(".h5ad"):
        return "h5ad"
    if lowered.endswith(".vcf.gz") or lowered.endswith(".vcf.bgz"):
        return "vcf-gz"
    if lowered.endswith(".vcf"):
        return "vcf"
    return "unknown"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def preview_h5ad(path: str, subset_cells: int) -> dict:
    """Read structure only: never load the matrix."""
    notes: list[str] = []
    n_obs = None
    n_vars = None

    try:
        import anndata  # type: ignore

        handle = anndata.read_h5ad(path, backed="r")
        n_obs, n_vars = int(handle.n_obs), int(handle.n_vars)
        notes.append("structure read via anndata (backed, read-only)")
        try:
            handle.file.close()
        except Exception:  # pragma: no cover - best effort close
            pass
    except ImportError:
        try:
            import h5py  # type: ignore

            with h5py.File(path, "r") as handle:
                if "X" in handle and hasattr(handle["X"], "shape"):
                    shape = handle["X"].shape
                    n_obs, n_vars = int(shape[0]), int(shape[1])
                elif "obs" in handle:
                    n_obs = len(handle["obs"])
            notes.append("structure read via h5py (anndata unavailable)")
        except ImportError:
            notes.append(
                "neither anndata nor h5py is installed: h5ad structure cannot be read here; "
                "install anndata (or h5py) before trusting any cell counts"
            )
        except Exception as error:  # pragma: no cover - unreadable file
            notes.append(f"h5ad structure unreadable: {error}")
    except Exception as error:  # pragma: no cover - unreadable file
        notes.append(f"h5ad structure unreadable: {error}")

    if n_obs is None:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "path": path,
            "format": "h5ad",
            "generatedAt": _now(),
            "subset": {
                "applied": True,
                "requestedCells": subset_cells,
                "sampledCells": subset_cells,
                "sampling": "head",
            },
            "fullRunRequired": True,
            "notes": notes,
        }

    sampled = min(subset_cells, n_obs)
    applied = sampled < n_obs
    if applied:
        notes.append(
            f"subset preview: {sampled}/{n_obs} cells — label results as downsampled (G6)"
        )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "path": path,
        "format": "h5ad",
        "generatedAt": _now(),
        "nObs": n_obs,
        "nVars": n_vars,
        "subset": {
            "applied": applied,
            "requestedCells": subset_cells,
            "sampledCells": sampled,
            "sampling": "head",
        },
        "fullRunRequired": applied,
        "notes": notes,
    }


def count_variants(path: str, compressed: bool, max_variants: int, full_scan: bool) -> tuple[int, bool, list[str]]:
    """Stream-count variant records; returns (count, truncated, notes)."""
    notes: list[str] = []
    opener = gzip.open if compressed else open
    limit = None if full_scan else max_variants
    count = 0
    truncated = False

    with opener(path, "rt", errors="replace") as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            if not line.strip():
                continue
            count += 1
            if limit is not None and count >= limit:
                truncated = True
                break

    if truncated:
        notes.append(
            f"variant scan stopped at {count} records (max-variants={max_variants}); "
            "count is a lower bound — run --full-scan or the full job on a compute host for the true total (G1)"
        )
    return count, truncated, notes


def preview_vcf(path: str, compressed: bool, max_variants: int, full_scan: bool) -> dict:
    count, truncated, notes = count_variants(path, compressed, max_variants, full_scan)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "path": path,
        "format": "vcf-gz" if compressed else "vcf",
        "generatedAt": _now(),
        "variantCount": count,
        "subset": {
            "applied": truncated,
            "requestedCells": max_variants,
            "sampledCells": count,
            "sampling": "head",
        },
        "fullRunRequired": truncated,
        "notes": notes,
    }


def build_manifest(
    path: str,
    subset_cells: int = DEFAULT_SUBSET_CELLS,
    max_variants: int = DEFAULT_MAX_VARIANTS,
    full_scan: bool = False,
) -> dict:
    fmt = detect_format(path)
    if fmt == "h5ad":
        return preview_h5ad(path, subset_cells)
    if fmt in ("vcf", "vcf-gz"):
        return preview_vcf(path, fmt == "vcf-gz", max_variants, full_scan)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "path": path,
        "format": "unknown",
        "generatedAt": _now(),
        "subset": {
            "applied": True,
            "requestedCells": subset_cells,
            "sampledCells": 0,
            "sampling": "head",
        },
        "fullRunRequired": True,
        "notes": [
            "unrecognized omics format: no structure preview available; "
            "convert to .h5ad or .vcf, or inspect bytes directly"
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Preview a large omics file without loading it.")
    parser.add_argument("--input", required=True, help="path to .h5ad / .vcf / .vcf.gz")
    parser.add_argument("--subset-cells", type=int, default=DEFAULT_SUBSET_CELLS)
    parser.add_argument("--max-variants", type=int, default=DEFAULT_MAX_VARIANTS)
    parser.add_argument("--full-scan", action="store_true", help="count every variant (large files: prefer a compute host)")
    parser.add_argument("--out", help="write the manifest JSON here (default: stdout)")
    args = parser.parse_args(argv)

    if not os.path.exists(args.input):
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2

    manifest = build_manifest(
        args.input,
        subset_cells=args.subset_cells,
        max_variants=args.max_variants,
        full_scan=args.full_scan,
    )
    payload = json.dumps(manifest, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
