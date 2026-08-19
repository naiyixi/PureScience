# EGFR T790M — Drug Discovery Intelligence Dossier

**Target:** EGFR T790M (epidermal growth factor receptor Thr790→Met mutant; *Homo sapiens*) · **Indication focus:** Non-small cell lung cancer (NSCLC) · **Generated:** 2026-08-19 · **Connectors:** ChEMBL (EBI) · ClinicalTrials.gov · PubMed (NCBI)

## Executive summary

The five most potent published small-molecule inhibitors of EGFR T790M, ranked by their best (most potent) ChEMBL IC50 against a T790M-bearing EGFR mutant, are **osimertinib (0.002 nM), aumolertinib (0.18 nM), lazertinib (0.3 nM), olmutinib (0.9 nM), and rociletinib (1.0 nM)**. Three are actively enrolled in clinical trials for NSCLC (osimertinib — 189 active trials, aumolertinib — 32, lazertinib — 22). **Olmutinib and rociletinib have no active NSCLC trials** — both had their development programmes discontinued.

## Merged data table (compound · target · IC50 · trial phase · status · sponsor)

| Rank | Compound | Target | IC50 vs T790M (nM) | Trial phase | Trial status | Sponsor (representative active trial) |
|---|---|---|---|---|---|---|
| 1 | Osimertinib (AZD9291) | EGFR T790M | 0.002 | Phase 3 | Active, not recruiting | AstraZeneca |
| 2 | Aumolertinib (almonertinib, HS-10296) | EGFR T790M | 0.18 | Phase 3 | Recruiting | Jiangsu Hansoh Pharmaceutical |
| 3 | Lazertinib (YH25448) | EGFR T790M | 0.3 | Phase 3 | Active, not recruiting | Janssen R&D / Johnson & Johnson |
| 4 | Olmutinib (HM61713, BI 1482694) | EGFR T790M | 0.9 | — | No active trials | — |
| 5 | Rociletinib (CO-1686) | EGFR T790M | 1.0 | — | No active trials | — |

*IC50 = most potent ChEMBL standard IC50 measured in an EGFR T790M-mutant assay (mostly L858R/T790M recombinant-enzyme); relation `=` or `<` as recorded. Chart: `egfr_t790m_ic50.png` (log scale).*

## Key literature (up to 3 papers per compound; PubMed-verified)

- **Osimertinib** — [Cross et al., *Cancer Discov* 2014](https://doi.org/10.1158/2159-8290.CD-14-0337) (PMID 24893891) · [Mok et al. (AURA3), *N Engl J Med* 2017](https://doi.org/10.1056/NEJMoa1612674) (PMID 27959700) · [Soria et al. (FLAURA), *N Engl J Med* 2018](https://doi.org/10.1056/NEJMoa1713137) (PMID 29151359)
- **Aumolertinib** — [T790M+ efficacy post-approval, *J Thorac Oncol* 2022](https://doi.org/10.1016/j.jtho.2021.10.024) (PMID 34801749) · [Lu et al. (AENEAS), *J Clin Oncol* 2022](https://doi.org/10.1200/JCO.21.02641) (PMID 35580297) · [CNS efficacy, *Cancer Commun* 2024](https://doi.org/10.1002/cac2.12594) (PMID 39016053)
- **Lazertinib** — [Structural basis of mutant-EGFR inhibition, *ACS Med Chem Lett* 2022](https://doi.org/10.1021/acsmedchemlett.2c00213) (PMID 36518696) · [Updated OS in T790M+ NSCLC, *BMC Med* 2024](https://doi.org/10.1186/s12916-024-03620-8) (PMID 39379931) · [Cho et al. (LASER301), *J Clin Oncol* 2023](https://doi.org/10.1200/JCO.23.00515) (PMID 37379502)
- **Olmutinib** — [Phase I/II T790M+ trial, *Lung Cancer* 2019](https://doi.org/10.1016/j.lungcan.2019.07.007) (PMID 31447004) · [T790M+ after first-line EGFR-TKI failure, *Cancer* 2021](https://doi.org/10.1002/cncr.33385) (PMID 33434335) · [Preclinical mechanism, *Front Pharmacol* 2018](https://doi.org/10.3389/fphar.2018.01097) (PMID 30356705)
- **Rociletinib** — [Walter et al. (CO-1686 discovery), *Cancer Discov* 2013](https://doi.org/10.1158/2159-8290.CD-13-0314) (PMID 24065731) · [Sequist et al. (TIGER-X), *N Engl J Med* 2015](https://doi.org/10.1056/NEJMoa1413654) (PMID 25923550) · [TIGER-3, *JTO Clin Res Rep* 2021](https://doi.org/10.1016/j.jtocrr.2020.100114) (PMID 34589984)

## Verification & data provenance

**Verified via connectors:**
- **ChEMBL** — compound identities (ChEMBL IDs), clinical phase, and T790M-mutant IC50 values for all 5 compounds, from full-page IC50 fetches filtered to T790M-annotated assays (assay_variant_mutation / assay_description). Mechanism confirmed for osimertinib (CHEMBL203, "binds irreversibly to certain mutant forms of EGFR (T790M, L858R, exon 19 del)").
- **ClinicalTrials.gov** — active-trial counts for NSCLC (osimertinib 189, aumolertinib 32, lazertinib 22, olmutinib 0, rociletinib 0) and NCT ID / phase / status / sponsor of representative active trials.
- **PubMed** — all 15 cited papers verified with PMID, journal, year, and DOI.

**Not found / not verifiable:**
- **No active NSCLC trials** for olmutinib or rociletinib (consistent with discontinued development: rociletinib was shelved by Clovis Oncology ~2016 after FDA scrutiny; olmutinib's global programme by Boehringer Ingelheim was halted in 2018). Their "no active trials" status is connector-verified; the discontinuation reasons are background context, not connector data.
- **No dedicated T790M target record** exists in ChEMBL; T790M data is nested under EGFR CHEMBL203 via assay annotations. Candidate pool was therefore the published third-generation (T790M-selective) EGFR-TKI class resolved in ChEMBL; a fully unguided sweep of all 12,691 EGFR IC50 records was not possible because the connector returns a single non-paginable page.
- **No ChEMBL records** were found under the names WZ4002, AS-1200, TAS-121 or BPI-15086 (additional candidate names screened), so these could not be ranked.
- Trial sponsor/phase for the representative trials were taken from search summaries; trial titles were truncated and full protocol details were not fetched.
