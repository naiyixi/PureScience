"""Recompute the Process Run Crate 0.5 reading recorded in
docs/evidence/2026-11-20-process-run-crate-2-1.md.

Usage:
    python3 docs/evidence/2026-11-20-process-run-crate-2-1.py <crate-dir>

<crate-dir> must be a crate written by the product's own exporter (it carries a Root Data
Entity, a metadata descriptor, one CreateAction with `instrument`, and a base
`conformsTo` on the Root Data Entity). Requires the reference validator:

    python3 -m venv /tmp/ps-val-venv
    /tmp/ps-val-venv/bin/pip install roc-validator==0.4.2

Every variant is derived from that one crate, so the only thing that differs between rows
is where `conformsTo` lives and which referenced ids are described.
"""

import json
import shutil
import sys
from pathlib import Path

from rocrate_validator import services, models

PROC = "https://w3id.org/ro/wfrun/process/0.5"
BASE_URL = "https://w3id.org/ro/crate/1.1"


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def entity(doc: dict, eid: str) -> dict:
    return next(e for e in doc["@graph"] if e.get("@id") == eid)


def variant(source: Path, name: str, mutate) -> Path:
    dst = Path(f"/tmp/ps-prc-{name}")
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(source, dst)
    meta = dst / "ro-crate-metadata.json"
    doc = load(meta)
    mutate(doc)
    meta.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    return dst


def validate(path: Path, severity=models.Severity.REQUIRED) -> list[str]:
    settings = services.ValidationSettings(
        data_path=str(path),
        profile_identifier="process-run-crate-0.5",
        requirement_severity=severity,
        abort_on_first=False,
    )
    result = services.validate(settings)
    return [f"{i.check.identifier}  {' '.join(i.message.split())[:120]}" for i in result.get_issues()]


def as_is(doc: dict) -> None:
    """Baseline: the Root Data Entity declares only the base spec."""


def on_descriptor(doc: dict) -> None:
    """The placement that looks right and is not: the metadata descriptor."""
    entity(doc, "ro-crate-metadata.json")["conformsTo"] = {"@id": PROC}


def on_root_only(doc: dict) -> None:
    """Right node, but nothing describes the referenced id."""
    entity(doc, "./")["conformsTo"] = {"@id": PROC}


def on_root_and_work(doc: dict) -> None:
    """Right node plus a described CreativeWork, but the base declaration is dropped."""
    entity(doc, "./")["conformsTo"] = {"@id": PROC}
    doc["@graph"].append({"@id": PROC, "@type": "CreativeWork", "name": "Process Run Crate 0.5"})


def both_described(doc: dict) -> None:
    """Both declarations kept, and both referenced ids described."""
    root = entity(doc, "./")
    root["conformsTo"] = [root["conformsTo"], {"@id": PROC}]
    doc["@graph"].append({"@id": BASE_URL, "@type": "CreativeWork", "name": "RO-Crate 1.1"})
    doc["@graph"].append({"@id": PROC, "@type": "CreativeWork", "name": "Process Run Crate 0.5"})


def list_one_entity(doc: dict) -> None:
    """The list keeps the base declaration, but only the profile id is described."""
    root = entity(doc, "./")
    root["conformsTo"] = [root["conformsTo"], {"@id": PROC}]
    doc["@graph"].append({"@id": PROC, "@type": "CreativeWork", "name": "Process Run Crate 0.5"})


def validate_base(path: Path) -> list[str]:
    settings = services.ValidationSettings(
        data_path=str(path),
        profile_identifier="ro-crate-1.1",
        requirement_severity=models.Severity.RECOMMENDED,
        abort_on_first=False,
    )
    result = services.validate(settings)
    return [f"{i.check.identifier}  {' '.join(i.message.split())[:120]}" for i in result.get_issues()]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    source = Path(sys.argv[1])
    table = {}
    for name, mutate in (
        ("baseline", as_is),
        ("descriptor", on_descriptor),
        ("root-only", on_root_only),
        ("root-work", on_root_and_work),
        ("both-described", both_described),
        ("list-one-entity", list_one_entity),
    ):
        table[name] = validate(variant(source, name, mutate))
    table["both-described (RECOMMENDED)"] = validate(
        Path("/tmp/ps-prc-both-described"), models.Severity.RECOMMENDED
    )
    # The recipe must not disturb the base profile's verdict.
    table["baseline (ro-crate-1.1 RECOMMENDED)"] = validate_base(Path("/tmp/ps-prc-baseline"))
    table["both-described (ro-crate-1.1 RECOMMENDED)"] = validate_base(Path("/tmp/ps-prc-both-described"))
    print(json.dumps(table, indent=1, ensure_ascii=False))
    return 0



if __name__ == "__main__":
    raise SystemExit(main())
