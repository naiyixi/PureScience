# Verdict report — rs1801133 (MTHFR C677T, p.Ala222Val)

**Question:** clinical significance of the variant, MTHFR function, and the meta-analytic evidence on
homocysteine and cardiovascular risk. Sources: Variants/ClinVar connector, Genes & Ontologies connector, PubMed.

---

## Executive verdict

| Item | Finding |
|---|---|
| **Variant** | rs1801133 = MTHFR c.665C>T, p.Ala222Val; chr1:11,796,321 G>A (GRCh38) |
| **ClinVar classification** | **Drug response** — 3★ (reviewed by expert panel), ClinVar variation ID 3520; *not* pathogenic/likely pathogenic |
| **Population frequency** | Very common polymorphism — gnomAD r4 exome AF ≈ 0.323 (80,805 homozygotes / 1,461,758 = 5.5%); genome AF ≈ 0.275 (4.5% homozygous) |
| **Function** | Methylenetetrahydrofolate reductase — 5,10-MTHF → 5-MTHF, the co-substrate for homocysteine→methionine remethylation (GO:0050667 homocysteine metabolism, GO:0035999 folate cycle) |
| **Effect of T allele** | Thermolabile enzyme → lower activity → higher plasma total homocysteine (TT−CC ≈ 1.9 µmol/L pooled; up to 3.1 µmol/L in low-folate regions) |
| **CV risk (meta-analyses)** | TT vs CC: CHD OR ≈ 1.14–1.16; stroke OR ≈ 1.26–1.68; effects **folate-dependent** — null after folic-acid fortification; B-vitamin RCTs show no event reduction |
| **Bottom line** | A common **pharmacogenetic/risk-factor** variant (label: *drug response*), not a disease-causing allele. Association with CVD is real but modest, and its causal interpretation is contested (genetic vs randomized evidence diverge). |

---

## 1. Clinical significance — Variants / ClinVar

*Resolved via the gnomAD-mirrored ClinVar snapshot (`clinvar_variants` for MTHFR; live NCBI E-utilities require a contact email that was not configured this session). Snapshot release **2026-06-06**.*

- **rs1801133 → 1-11796321-G-A** (GRCh38), `missense_variant` on ENST00000376590 (canonical MTHFR transcript).
- **Clinical significance: `drug response`**, **3 gold stars**, review status **"reviewed by expert panel"**.
- ClinVar does **not** classify C677T as pathogenic/likely pathogenic — consistent with its status as a very common functional polymorphism. Its clinical relevance is primarily **pharmacogenetic** (folate/methotrexate handling) and as a **risk factor** rather than a Mendelian disease allele.
- **gnomAD r4 frequencies** (get_variant): exome AF **0.323** (AN 1,461,758; homozygotes 80,805); genome AF **0.275** (AN 152,088; homozygotes 6,918). The T allele is common in most populations (highest in East/South Asian and Mediterranean groups).

---

## 2. Gene function — Genes & Ontologies

- **MTHFR** (ENSG00000177000, Entrez 4524, UniProt **P42898**): methylenetetrahydrofolate reductase. RefSeq: *catalyzes conversion of 5,10-methylenetetrahydrofolate to 5-methyltetrahydrofolate, a co-substrate for homocysteine remethylation to methionine; variation influences susceptibility to occlusive vascular disease, neural tube defects, colon cancer and acute leukaemia.*
- **GO annotations (QuickGO, human):**
  - *Molecular function:* methylenetetrahydrofolate reductase [NAD(P)H] activity (GO:0004489); FAD binding (GO:0050660); modified-amino-acid binding (GO:0072341).
  - *Biological process:* **homocysteine metabolic process** (GO:0050667, IDA), **folate cycle** (GO:0035999), L-methionine biosynthesis (GO:0071265), S-adenosylmethionine metabolism (GO:0046500), neural tube closure (GO:0001843, IMP), responses to folic acid (GO:0051593) and vitamin B2/riboflavin (GO:0033274).
  - *Cellular component:* cytosol (GO:0005829).
- **Biological bridge:** the 677C>T transition (p.Ala222Val) yields a thermolabile enzyme with reduced activity, blunting homocysteine remethylation and raising plasma total homocysteine — the phenotype through which the variant is connected to vascular disease (quantified in §3). This is why the effect is **folate-modulated**: high dietary folate compensates for reduced enzyme activity.

---

## 3. Meta-analytic evidence on homocysteine & cardiovascular risk — PubMed

Six published meta-analyses yield the odds ratios shown in the forest plot
(`rs1801133_mthfr_c677t_forest.png`). Genotype rows compare **TT vs CC**; homocysteine rows are per **+5 µmol/L** plasma total homocysteine.

| # | Source (PMID / DOI) | Outcome · comparison | OR (95% CI) |
|---|---|---|---|
| 1 | Klerk 2002, *JAMA* (12387655, 10.1001/jama.288.16.2023) | CHD · TT vs CC · global (n=11,162 cases) | **1.16 (1.05–1.28)** |
| 2 | Klerk 2002, *JAMA* | CHD · TT vs CC · Europe | **1.14 (1.01–1.28)** |
| 3 | Klerk 2002, *JAMA* | CHD · TT vs CC · North America | **0.87 (0.73–1.05)** |
| 4 | Lewis 2005, *BMJ* (16216822, 10.1136/bmj.38615.706988.4F) | CHD · TT vs CC · global (80 studies; 26,000 cases) | **1.14 (1.05–1.24)** |
| 5 | Wald 2002, *BMJ* (12446535, 10.1136/bmj.325.7374.1202) | IHD · per +5 µmol/L Hcy · genetic studies | **1.42 (1.11–1.84)** |
| 6 | Wald 2002, *BMJ* | IHD · per +5 µmol/L Hcy · prospective studies | **1.32 (1.19–1.45)** |
| 7 | Wald 2002, *BMJ* | Stroke · per +5 µmol/L Hcy · prospective studies | **1.59 (1.29–1.96)** |
| 8 | Casas 2005, *Lancet* (15652605, 10.1016/S0140-6736(05)17742-3) | Stroke · TT vs CC (n=13,928) | **1.26 (1.14–1.40)** |
| 9 | Holmes 2011, *Lancet* (21803414, 10.1016/S0140-6736(11)60872-6) | Stroke · TT vs CC · low-folate Asia (20,885 events) | **1.68 (1.44–1.97)** |
| 10 | Holmes 2011, *Lancet* | Stroke · TT vs CC · folate-fortified (Americas/AUS/NZ) | **1.03 (0.84–1.25)** |
| 11 | Den Heijer 2005, *J Thromb Haemost* (15670035, 10.1111/j.1538-7836.2005.01545.x) | Venous thromboembolism · TT vs CC (53 studies) | **1.20 (1.08–1.32)** |
| 12 | Den Heijer 2005, *J Thromb Haemost* | VTE · per +5 µmol/L Hcy · prospective studies | **1.27 (1.01–1.59)** |

**Synthesis of the pattern:**
- **Consistent but modest association.** Pooled TT-vs-CC ORs cluster at **1.14–1.26** for CHD and stroke; no meta-analysis reported a large effect.
- **Folate status is the effect modifier.** The genotype effect is strongest in low-folate regions (stroke OR 1.68 in Asia; Holmes 2011), attenuated in Europe, and **null in folic-acid–fortified populations** (North America CHD OR 0.87; fortified-region stroke OR 1.03). Klerk (Europe 1.14 vs North America 0.87) and Den Heijer (North America null) show the same gradient.
- **Genetic vs prospective triangulation.** Wald 2002: ORs per +5 µmol/L homocysteine from MTHFR-genetic studies (1.42 IHD) and prospective cohorts (1.32 IHD; 1.59 stroke) agree closely — the basis for the original *causal* claim. Casas 2005 confirmed consistency between expected and observed genotype ORs for stroke (1.20 expected vs 1.26 observed).
- **But randomized evidence diverges.** Holmes 2011's meta-analysis of 13 homocysteine-lowering (B-vitamin) RCTs (45,549 participants, 2,314 strokes) found **no reduction** in stroke or CHD events, and the genotype effect was already ~null in the folate-fortified populations where the RCTs ran.
- **Modern umbrella review** (Castagna 2026, *Aging Clin Exp Res*, 42430052): high-certainty GRADE evidence linking hyperhomocysteinemia to stroke and intracerebral haemorrhage; most underlying meta-analyses were low/very-low certainty.

---

## 4. Verdict

1. **Clinical significance:** rs1801133 is a **common functional polymorphism** labelled in ClinVar as **drug response (3★, expert panel)** — not a pathogenic variant for MTHFR deficiency and not clinically actionable as a disease-causing allele for cardiovascular disease.
2. **Function:** the T allele encodes a thermolabile MTHFR with reduced activity, raising plasma homocysteine in a **folate-dependent** manner.
3. **Cardiovascular risk:** the association with CHD/stroke is **real but modest (OR ≈ 1.1–1.3 pooled) and folate-dependent** — robust in low-folate settings, absent after folic-acid fortification. Per-+5-µmol/L homocysteine risk (IHD 1.32–1.42; stroke 1.59) is moderate.
4. **Causality:** genetic and prospective observational evidence triangulate toward a causal link, but **homocysteine-lowering RCTs show no event reduction**, leaving the causal interpretation contested. The variant is best framed as a **risk biomarker / pharmacogenetic marker (folate, methotrexate)**, and population folic-acid fortification appears to have neutralised most of its cardiovascular impact.

---

## Sources (PubMed, cited as required)

- Klerk M, et al. MTHFR 677C→T polymorphism and risk of coronary heart disease: a meta-analysis. *JAMA* 2002;288(16):2023–31. https://doi.org/10.1001/jama.288.16.2023 (PMID 12387655)
- Wald DS, et al. Homocysteine and cardiovascular disease: evidence on causality from a meta-analysis. *BMJ* 2002;325(7374):1202. https://doi.org/10.1136/bmj.325.7374.1202 (PMID 12446535)
- Lewis SJ, et al. Meta-analysis of MTHFR 677C→T polymorphism and coronary heart disease: does totality of evidence support causal role for homocysteine and preventive potential of folate? *BMJ* 2005;331:1053. https://doi.org/10.1136/bmj.38615.706988.4F (PMID 16216822)
- Casas JP, et al. Homocysteine and stroke: evidence on a causal link from Mendelian randomisation. *Lancet* 2005;365(9455):224–32. https://doi.org/10.1016/S0140-6736(05)17742-3 (PMID 15652605)
- Holmes MV, et al. Effect modification by population dietary folate on the association between MTHFR genotype, homocysteine, and stroke risk… *Lancet* 2011;378(9791):2013–24. https://doi.org/10.1016/S0140-6736(11)60872-6 (PMID 21803414)
- Den Heijer M, et al. Homocysteine, MTHFR and risk of venous thrombosis… *J Thromb Haemost* 2005;3(2):292–9. (PMID 15670035)
- Castagna A, et al. Hyperhomocysteinemia, a risk factor for various health conditions: an umbrella review. *Aging Clin Exp Res* 2026. (PMID 42430052)

*Connectors used: Variants (gnomAD + ClinVar mirror), Genes & Ontologies (mygene.info, QuickGO, RefSeq), PubMed (esearch/efetch). Variant frequencies: gnomAD v4. ClinVar snapshot: 2026-06-06.*
