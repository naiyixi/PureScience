"""Independent third-party read of an RO-Crate directory — the acceptance instrument for roadmap 4.2.

Two readings that share nothing with our code:

  1. `rocrate` (ELIXIR's reference implementation, 0.16.0) — opens the crate the way an external
     consumer would, then re-hashes every file entity with its own hashlib.
  2. `pyld` (general-purpose JSON-LD 3.3.0) — expands `ro-crate-metadata.json` against the contexts it
     declares, so a wrong local term declaration (our `sha256` term) shows up as an un-expanded key.

Usage:
    python3 -m venv /tmp/ps-rocrate-venv
    /tmp/ps-rocrate-venv/bin/pip install rocrate pyld requests   # mirror: -i https://pypi.tuna.tsinghua.edu.cn/simple
    /tmp/ps-rocrate-venv/bin/python docs/evidence/2026-11-18-ro-crate-third-party-read.py <crate-dir>

Exit code 0 = both readings passed. Anything else prints what failed, by name.
"""
import hashlib
import json
import os
import sys

FILE_TYPES = {"http://schema.org/MediaObject", "http://schema.org/File", "http://www.w3.org/ns/ro-crate#File"}
ROOT_TYPE = "http://schema.org/Dataset"
SHA = "http://schema.org/sha256"
HAS_PART = "http://schema.org/hasPart"


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_with_reference_library(crate_dir):
    from rocrate.rocrate import ROCrate

    crate = ROCrate(crate_dir)
    entities = list(crate.get_entities())
    by_id = {e.id: e for e in entities}
    files = [e for e in entities if any("File" in json.dumps(e.get("@type")) for _ in [0])]

    missing, no_sha, sha_mismatch, size_mismatch = [], [], [], []
    for f in files:
        path = os.path.join(crate_dir, f.id)
        if not os.path.exists(path):
            missing.append(f.id)
            continue
        declared = f.get(SHA) or f.get("sha256")
        declared_size = f.get("contentSize") or f.get("http://schema.org/contentSize")
        if not declared:
            no_sha.append(f.id)
        elif sha256_of(path) != declared:
            sha_mismatch.append(f.id)
        if declared_size is not None and int(declared_size) != os.path.getsize(path):
            size_mismatch.append((f.id, declared_size, os.path.getsize(path)))

    def ref_id(part):
        if isinstance(part, dict):
            return part.get("@id")
        if hasattr(part, "id"):
            return part.id
        return str(part)

    dangling = []
    for e in entities:
        for part in e.get("hasPart", []) or []:
            if ref_id(part) not in by_id:
                dangling.append((e.id, ref_id(part)))

    root = crate.root_dataset
    root_parts = {ref_id(p) for p in (root.get("hasPart") or [])}
    unreachable = [f.id for f in files if f.id not in root_parts]

    report = {
        "reader": "rocrate 0.16.0",
        "root_id": root.id,
        "root_type": root.get("@type"),
        "entities": len(entities),
        "files": len(files),
        "files_missing_on_disk": len(missing),
        "files_without_sha256": len(no_sha),
        "files_with_sha_mismatch": len(sha_mismatch),
        "files_with_size_mismatch": len(size_mismatch),
        "dangling_hasPart": len(dangling),
        "files_not_reachable_from_root": len(unreachable),
        "root_has_author": "author" in root.properties(),
        "root_has_license": "license" in root.properties(),
        "create_actions": sum(1 for e in entities if "CreateAction" in json.dumps(e.get("@type"))),
    }
    ok = not any(
        report[key]
        for key in (
            "files_missing_on_disk",
            "files_without_sha256",
            "files_with_sha_mismatch",
            "files_with_size_mismatch",
            "dangling_hasPart",
            "files_not_reachable_from_root",
        )
    )
    return report, ok


def expand_with_jsonld(crate_dir):
    import requests
    from pyld import jsonld

    def loader(url, options=None):
        resp = requests.get(url, timeout=30, allow_redirects=True)
        return {
            "contentType": resp.headers.get("content-type", "application/ld+json"),
            "contextUrl": None,
            "documentUrl": url,
            "document": resp.json(),
        }

    with open(os.path.join(crate_dir, "ro-crate-metadata.json"), encoding="utf-8") as fh:
        document = json.load(fh)
    expanded = jsonld.expand(document, {"documentLoader": loader, "base": ""})

    root = next((n for n in expanded if ROOT_TYPE in n.get("@type", []) and HAS_PART in n), None)
    files = [n for n in expanded if FILE_TYPES & set(n.get("@type", []))]
    with_sha = [n for n in files if SHA in n]
    part_refs = [ref.get("@id") for ref in (root or {}).get(HAS_PART, [])]
    ids = {n.get("@id") for n in expanded}

    unexpanded = set()

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key.startswith("@"):
                    continue
                if ":" not in key:
                    unexpanded.add(key)
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(expanded)

    report = {
        "reader": "pyld 3.3.0 (JSON-LD expansion)",
        "nodes": len(expanded),
        "root_present": root is not None,
        "root_conformsTo": [c.get("@id") for c in (root or {}).get("http://purl.org/dc/terms/conformsTo", [])],
        "file_nodes": len(files),
        "file_nodes_with_sha256": len(with_sha),
        "unexpanded_terms": sorted(unexpanded),
        "hasPart_refs": len(part_refs),
        "dangling_hasPart": len([r for r in part_refs if r not in ids]),
        "create_actions": sum(1 for n in expanded if "http://schema.org/CreateAction" in n.get("@type", [])),
    }
    ok = (
        report["root_present"]
        and report["file_nodes"] > 0
        and report["file_nodes_with_sha256"] == report["file_nodes"]
        and report["unexpanded_terms"] == []
        and report["hasPart_refs"] == report["file_nodes"]
        and report["dangling_hasPart"] == 0
    )
    return report, ok


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    crate_dir = sys.argv[1]
    report_a, ok_a = read_with_reference_library(crate_dir)
    report_b, ok_b = expand_with_jsonld(crate_dir)
    for report in (report_a, report_b):
        print(json.dumps(report, ensure_ascii=False, indent=2))
    print("VERDICT", "PASS" if (ok_a and ok_b) else "FAIL")
    return 0 if (ok_a and ok_b) else 1


if __name__ == "__main__":
    sys.exit(main())
