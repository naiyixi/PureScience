---
name: bionexus-protein-structure-analysis
contract: '{"id":"bionexus-protein-structure-analysis","aliases":["结构文件","对接准备","structure prep"],"requires":["input:protein_id"],"produces":["data:structure_file"],"failure_policy":{"missing_state":"Give a PDB/AlphaFold accession first; these fetchers download existing files, they do not fold proteins."}}'
description: Only if the user explicitly asked for structure I/O or docking prep. Fetches PDB/AF files and writes Vina config. Does not run AlphaFold/DiffDock. Not a default analysis skill.
---

# Structure I/O and docking prep

- Fetchers download existing files. They do not fold proteins.
- Pocket detector is a CA grid heuristic (`evidence_grade=C`).
- `molecular_docking.py` writes a config file. It does not launch Vina unless the user runs the binary.
- TM-score after length truncation is not TM-align.
