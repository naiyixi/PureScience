# PureScience — Independent Acceptance & Benchmark Notes

> Status: internal acceptance data, published honestly. Every claim below is pinned to a shipped
> version and a re-checkable local run — this page is **not** a vendor benchmark and makes no claim
> to cover the field. Numbers are reported as measured on the run that produced them.

## How this page is produced

PureScience verifies itself by running **real end-to-end research tasks locally**, keeping the
session, tool activity, executed code, and artifact files, and then **re-checking the key data
points against the public sources** after the run. Nothing on this page is a mock, a curated
screenshot of a canned answer, or a number taken on trust from the model.

Rules of the acceptance suite:

1. **Real runs, real files.** Each case is a real local session on a pinned version; every
   artifact behind a screenshot can be opened from its project session path.
2. **"Verified" is separated from "could not be verified".** Reports state explicitly which data
   came back from connectors and which could not be found — no guessing, no filler.
3. **Limitations are logged.** Failed steps, mid-run self-corrections, and hardware-bound
   downgrades (e.g. "ESMFold unavailable without a GPU") stay on the record as negative samples.

## The 13-project acceptance suite

The acceptance suite spans seven capability levels — L1 literature synthesis through L7 evidence
chain and reproducibility — across protein design, cross-database consistency, paper reproduction
with counter-evidence, compound-target selectivity audits, anti-hallucination stress tests,
single-cell analysis, environment reconstruction, and drug-evidence cross-checks.

![The 13-project acceptance suite](capability-2026-09/acceptance-13-projects.png)

*Screenshots from real local sessions on PureScience v1.37.*

## Selected verified runs

### Drug-discovery dossier — EGFR T790M (non-small cell lung cancer)

One natural-language prompt → a multi-step agentic run (~11 minutes) that queried three scientific
databases (ChEMBL, ClinicalTrials.gov, PubMed — 19 connector calls), executed 34 notebook cells
(Python + pandas + matplotlib), caught and fixed two of its own bugs, and delivered three artifacts
with provenance:

| Deliverable | File |
|---|---|
| One-page dossier with citations and a verified-vs-not-found statement | [demo-verification/egfr_t790m_dossier.md](demo-verification/egfr_t790m_dossier.md) |
| Merged table (compound · target · IC50 · trial phase · status · sponsor) | [demo-verification/egfr_t790m_merged.csv](demo-verification/egfr_t790m_merged.csv) |
| Potency figure (log scale; green = active trials, grey = none) | [demo-verification/egfr_t790m_ic50.png](demo-verification/egfr_t790m_ic50.png) |

**Independent re-check after the run:** 5/5 ChEMBL IC50 values, the representative FLAURA2 trial
(NCT04035486) on ClinicalTrials.gov, and the cited PMIDs on PubMed all match. Full report:
[demo-verification/egfr-t790m-dossier-verification.md](demo-verification/egfr-t790m-dossier-verification.md).

### Molecular dynamics — SARS-CoV-2 Mpro + nirmatrelvir (laptop-run)

Docking + explicit-solvent MD on a laptop (no cluster):

- 280 docking poses scored by interaction energy; best E_int −52.9 kcal/mol; 16/21 pocket contacts
  match the crystal.
- Explicit-solvent MD with 82,563 atoms: protein Cα RMSD 0.93 Å, ligand RMSD 0.79 Å; the key
  Glu166 hydrogen bond held in 62% of frames.
- The report states its own limitations (charge model, non-covalent approximation, 1 ns scale,
  monomer).

![Molecular dynamics results — docking scoring + MD stability](capability-2026-09/md-results-stability.png)

### Dry side meets the wet bench — protein-design workspace

Three tasks in one project (GFP/enzyme panel for E. coli expression, de-novo SARS-CoV-2 RBD
binders against PDB 6M0J, 1,000-sequence Ubiquitin inverse folding against PDB 1UBQ). The 9-row
GFP panel (V0–V8: designed spectra, monomerization, pH axis, dark control) ships as a wet-lab
handoff document with ORF FASTA and metadata TSV.

![Protein-design workspace](capability-2026-09/protein-design-wetlab-panel.png)

### Honesty is logged, not hidden

Mid-run the agent caught its own bug and fixed it on record — "chromophore detection was wrong:
water molecules were treated as protein-like HETATM" — and, without a GPU, stated ESMFold was
unavailable and switched to structure-anchored design instead of pretending.

![GFP design run — self-correction on record](capability-2026-09/gfp-honesty-run.png)

## Honest scope

- **This is internal acceptance data.** It shows what PureScience has run and re-verified on this
  machine, not a comparison against every tool in the field. Independent third-party evaluation is
  welcome; treat any third-party claims about PureScience with the same scrutiny.
- **Version-pinned.** Screenshots and numbers above are pinned to PureScience v1.37 sessions.
  Capabilities evolve between releases — the installed app and
  [release notes](https://github.com/naiyixi/PureScience/releases/latest) are authoritative for the
  current shape.
- **Reproduction.** Every artifact file is in this repository under `docs/` and is re-checkable;
  re-running the underlying tasks locally is the definitive verification.

## Re-verify it yourself

1. Install PureScience (macOS Apple Silicon) and create a project.
2. Open any case under `docs/demo-verification/` or `docs/capability-2026-09/` and follow its
   session/artifact paths.
3. Re-check the stated database IDs (ChEMBL compounds, ClinicalTrials.gov NCT IDs, PMIDs) against
   the public APIs — the reports in this repo list exactly which values were re-verified.
