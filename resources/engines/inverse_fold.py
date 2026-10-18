#!/usr/bin/env python3
"""Inverse folding (backbone -> sequences) for the app's design path.

One subcommand, JSON on stdout so the caller never parses prose:

  design --pdb IN.pdb --out DIR --engine-src DIR --weights DIR
         [--num 1] [--temp 0.1] [--seed 37] [--model v_48_020]

What it reports and why each field is there:

  * `sequences` carries the designed chain(s) with the engine's own per-sequence score and the
    sequence recovery it computed against the input — the caller ranks; this script does not.
  * `engineSha256` / `weightsSha256` / `seed` / `temperature` / `model` are the recomputable input
    fingerprint. The same PDB + seed + model + temperature produce the same sequences, so anyone
    can re-run the same four values outside the app and get the same bytes back — that is what
    makes a design citable rather than decorative.
  * `nativeSequence` is the input chain's sequence as the engine parsed it, so the caller can
    show what was designed *from* without a second parser of its own.

Failures are named, and every one of them is a different name on purpose:

  engine-missing       the engine source tree is not where the caller said it is
  weights-unreadable   the weight file is absent, truncated or not a torch checkpoint
  pdb-unreadable       the input structure cannot be read
  design-failed        the engine itself raised; the message is the engine's, verbatim

Nothing here decides what a good design is: the engine samples, the caller judges, and a
prediction never becomes a measurement by being reported by this script.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fail(code, message):
    """One JSON line on stdout, a non-zero exit: the caller reads the code, never the prose."""
    print(json.dumps({"status": "error", "code": code, "message": message}))
    sys.exit(2)


def _check_weights(weights_dir, model):
    """A half-downloaded checkpoint makes torch raise something unrelated to the real cause, so the
    file is inspected before the engine ever touches it."""
    path = Path(weights_dir) / f"{model}.pt"
    if not path.is_file():
        _fail("weights-unreadable", f"missing {path}")
    if path.stat().st_size < 1024:
        _fail("weights-unreadable", f"{path} is {path.stat().st_size} bytes")
    with open(path, "rb") as handle:
        head = handle.read(4)
    # torch checkpoints are zip archives; anything else is not one.
    if head[:2] != b"PK":
        _fail("weights-unreadable", f"{path} is not a torch checkpoint")
    return path


def _read_fasta(path):
    """Parse what the engine wrote. The header carries the facts the caller records; the sequence is
    the second line. Blank lines are skipped rather than trusted to be absent."""
    entries = []
    header = None
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(">"):
            header = line[1:]
        elif header is not None:
            entries.append({"header": header, "sequence": line})
            header = None
    return entries


def _number(header, key):
    """The engine writes `key=value` into the FASTA header; pull one out or return None — never guess."""
    for field in header.replace(",", " ").split():
        if field.startswith(f"{key}="):
            return field[len(key) + 1 :]
    return None


def design(args):
    src = Path(args.engine_src)
    runner = src / "protein_mpnn_run.py"
    if not runner.is_file():
        _fail("engine-missing", f"no protein_mpnn_run.py under {src}")
    pdb = Path(args.pdb)
    if not pdb.is_file():
        _fail("pdb-unreadable", f"missing {pdb}")
    weights = _check_weights(args.weights, args.model)

    out_dir = Path(args.out)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(src))
    try:
        import torch  # noqa: F401  — imported here so a missing stack fails by name, not silently
    except Exception as error:  # noqa: BLE001
        _fail("engine-missing", f"torch unavailable in this interpreter: {error}")

    import subprocess

    command = [
        sys.executable,
        str(runner),
        "--pdb_path",
        str(pdb),
        "--out_folder",
        str(out_dir),
        "--num_seq_per_target",
        str(args.num),
        "--sampling_temp",
        str(args.temp),
        "--seed",
        str(args.seed),
        "--batch_size",
        "1",
        "--model_name",
        args.model,
        "--path_to_model_weights",
        str(Path(args.weights)),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, cwd=str(src))
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-6:]
        _fail("design-failed", " | ".join(tail) or f"exit {completed.returncode}")

    fasta = next(iter(sorted((out_dir / "seqs").glob("*.fa"))), None)
    if fasta is None:
        _fail("design-failed", f"no .fa under {out_dir / 'seqs'}")

    entries = _read_fasta(fasta)
    if not entries:
        _fail("design-failed", f"{fasta} has no sequences")

    # The first entry is the native chain as the engine parsed it; the rest are samples.
    native = entries[0]["sequence"]
    samples = []
    for index, entry in enumerate(entries[1:], start=1):
        samples.append(
            {
                "index": index,
                "sequence": entry["sequence"],
                "score": _number(entry["header"], "score"),
                "globalScore": _number(entry["header"], "global_score"),
                "sequenceRecovery": _number(entry["header"], "seq_recovery"),
            }
        )

    print(
        json.dumps(
            {
                "status": "ok",
                "engine": "proteinmpnn",
                "model": args.model,
                "seed": args.seed,
                "temperature": args.temp,
                "pdb": str(pdb),
                "pdbSha256": _sha256(pdb),
                "weightsSha256": _sha256(weights),
                "engineSha256": _sha256(runner),
                "nativeSequence": native,
                "samples": samples,
                # The recomputable handle: what a second party needs to reproduce these sequences.
                "reproduce": {
                    "engine": "proteinmpnn",
                    "model": args.model,
                    "seed": args.seed,
                    "temperature": args.temp,
                    "pdbSha256": _sha256(pdb),
                    "weightsSha256": _sha256(weights),
                    "num": args.num,
                },
            }
        )
    )


def main():
    parser = argparse.ArgumentParser(description="inverse folding engine")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("design", help="backbone -> sequences")
    p.add_argument("--pdb", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--engine-src", required=True)
    p.add_argument("--weights", required=True)
    p.add_argument("--num", type=int, default=1)
    p.add_argument("--temp", type=float, default=0.1)
    p.add_argument("--seed", type=int, default=37)
    p.add_argument("--model", default="v_48_020")
    p.set_defaults(handler=design)

    args = parser.parse_args()
    if not os.path.isdir(args.engine_src if hasattr(args, "engine_src") else "."):
        _fail("engine-missing", "engine source directory does not exist")
    args.handler(args)


if __name__ == "__main__":
    main()
