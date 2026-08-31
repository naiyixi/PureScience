import type { ConnectorGroup } from '../../shared/settings'

export type ConnectorMeta = {
  id: string
  displayName: string
  // User-facing/source aliases used by the bridge's deterministic per-turn router.
  aliases?: string[]
  description: string
  // Trigger-style summary ("Use when …") that drives automatic skill discovery — the agent matches a
  // plain user question against this without the user naming the connector. Keep it query-oriented.
  useWhen: string
  sources: string[]
  termsUrl?: string
  requiresNcbi: boolean
  // Settings-list section. Absent = "featured" (Anthropic research connectors); "directory" connectors
  // mirror entries in the Claude Connectors Directory.
  group?: ConnectorGroup
}

// Static connector metadata for the settings UI (tool lists come from the registry).
export const CONNECTOR_CATALOG: ConnectorMeta[] = [
  {
    id: 'chemistry',
    displayName: '化学',
    description: '通过 PubChem、ChEBI、Rhea 和 BindingDB 获取小分子化学数据。',
    useWhen:
      'Use when a question needs authoritative small-molecule chemistry data — PubChem compound properties (formula, weight, SMILES/InChI, IUPAC name), CID resolution and 2D similarity search, bioassay and GHS safety summaries; ChEBI ontology entities, roles and relations; Rhea enzyme reactions (by ChEBI participant, EC number, or equation text); or BindingDB binding affinities (Ki/Kd/IC50/EC50) by protein target or compound. Sourced from PubChem, ChEBI, Rhea and BindingDB.',
    sources: ['PubChem', 'ChEBI', 'Rhea', 'BindingDB'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
    requiresNcbi: false
  },
  {
    id: 'delegate',
    displayName: '多代理编排',
    description: '并行子代理委派——将独立子任务作为全新代理会话运行。',
    useWhen:
      'Use when a task decomposes into independent parallel sub-tasks (parallel literature reviews, decompose-and-conquer analyses, multi-perspective evaluation) that each deserve their own agent turn loop. Only available inside a live agent session.',
    sources: ['ACP runtime'],
    requiresNcbi: false
  },
  {
    id: 'literature',
    displayName: '文献图谱',
    description: '学术文献图谱——OpenAlex 作品/作者/期刊/引用、arXiv 元数据。',
    useWhen:
      'Use when exploring the scholarly literature graph — searching works/papers by topic with citation counts and authors, following a work’s citations or references, looking up authors (ORCID, h-index, institution) or a venue/journal, or searching arXiv preprints. Sourced from OpenAlex and arXiv.',
    sources: ['OpenAlex', 'arXiv'],
    termsUrl: 'https://docs.openalex.org/additional-help/terms',
    requiresNcbi: false
  },
  {
    id: 'molecule',
    displayName: '分子查看器',
    description:
      '验证并预览 2D 分子结构和反应（OpenChemLib）。支撑 .mol/.sdf/.smi/.smiles/.rxn 工件查看器。',
    useWhen:
      'Use when the user provides or wants to inspect a chemical structure — validating or normalizing a SMILES or MDL molfile, computing a molecular formula / weight / heavy-atom count, or turning a structure into a previewable 2D depiction. The paired viewer also renders MDL reaction (.rxn) files. Self-contained: pass a SMILES or molfile directly, no other connector required. Sourced from OpenChemLib (offline, in-app).',
    sources: ['OpenChemLib'],
    requiresNcbi: false
  },
  {
    id: 'pubmed',
    displayName: 'PubMed',
    aliases: ['NCBI literature', 'PMC', 'Europe PMC'],
    description:
      '通过 NCBI E-utilities、PMC ID 转换器和 Europe PMC 检索生物医学文献——搜索、元数据、相关文章、引用查询、ID 转换、全文与版权。',
    useWhen:
      'Use to search the biomedical literature and retrieve article metadata (authors, abstract, DOIs, MeSH), find related/similar articles, resolve citations to PMIDs, convert between PMID/PMCID/DOI, fetch open-access full text from PubMed Central, or check copyright/license status. Sourced from PubMed (NCBI), PMC and Europe PMC.',
    sources: ['PubMed', 'PMC', 'Europe PMC'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
    requiresNcbi: true,
    group: 'directory'
  },
  {
    id: 'genes',
    displayName: '基因与本体',
    aliases: ['MyGene', 'mygene.info', 'UniProt', 'gene information', 'gene annotation'],
    description:
      '基因/蛋白质身份与本体术语——mygene.info、UniProt、OLS4 本体、GO 注释、Reactome 通路。',
    useWhen:
      'Use when you need to resolve gene symbols/identifiers (mygene.info), fetch UniProt protein records, look up or search ontology terms (EFO, GO, CL, ChEBI, MONDO via OLS4), retrieve GO annotations for a protein (QuickGO), or map genes to Reactome pathways.',
    sources: ['MyGene', 'UniProt', 'OLS', 'QuickGO', 'Reactome'],
    termsUrl: 'https://www.uniprot.org/help/license',
    requiresNcbi: false
  },
  {
    id: 'genomes',
    displayName: '基因组',
    description: '基因组注释、变异、同源性、序列和浏览器轨道——Ensembl REST 与 UCSC 基因组浏览器。',
    useWhen:
      'Use when you need Ensembl gene/transcript annotation, cross-references, VEP variant consequences, orthologues/paralogues, sequence, or region overlaps — or UCSC Genome Browser tracks, track data, conservation scores, TFBS clusters and chromosome sizes.',
    sources: ['Ensembl', 'UCSC'],
    termsUrl: 'https://www.ensembl.org/info/about/legal/disclaimer.html',
    requiresNcbi: false
  },
  {
    id: 'variants',
    displayName: '变异',
    aliases: ['gnomAD', 'ClinVar', 'dbSNP', 'CADD', 'genetic variant'],
    description:
      '人类遗传变异——gnomAD 群体频率/约束、ClinVar 记录/搜索（NCBI 直连）、dbSNP、CADD 危害评分、结构变异和线粒体变异。',
    useWhen:
      'Use when you need human genetic-variant data — gnomAD population allele frequencies, gene constraint (pLI/LOEUF), structural or mitochondrial variants, and build liftover; ClinVar clinical significance (gnomAD mirror or direct NCBI search/records by accession or rsID); dbSNP RefSNP records and region lookups; or CADD deleteriousness scores (PHRED/raw) for SNVs.',
    sources: ['gnomAD', 'ClinVar', 'dbSNP', 'CADD'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/clinvar/docs/maintenance_use/',
    requiresNcbi: true
  },
  {
    id: 'clinical_trials',
    displayName: '临床试验',
    description: 'ClinicalTrials.gov 临床试验——搜索、详情、赞助方、研究者、终点和入组标准。',
    useWhen:
      'Use for ClinicalTrials.gov: search trials by condition/intervention/sponsor/location/status/phase, fetch full details by NCT id, find trials by sponsor, discover investigators and sites, analyze trial endpoints, or match patients by eligibility.',
    sources: ['ClinicalTrials.gov'],
    termsUrl: 'https://clinicaltrials.gov/about-site/terms-conditions',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'clinical_genomics',
    displayName: '临床基因组学',
    aliases: ['ClinGen', 'CIViC', 'Open Targets'],
    description: '临床基因组学知识库：ClinGen 策展、CIViC 临床证据和 Open Targets 平台。',
    useWhen:
      "Use when you need clinical interpretation of genes and variants — ClinGen gene-disease validity, dosage sensitivity, clinical actionability, and expert-panel (VCEP) variant pathogenicity classifications; CIViC clinical evidence, assertions, molecular profiles, diseases, and therapies for a gene or variant in cancer; or Open Targets target-disease association scores, a disease's known drugs/associated targets, a drug's mechanism of action, and arbitrary Open Targets GraphQL. Sourced from ClinGen, CIViC, and the Open Targets Platform.",
    sources: ['ClinGen', 'CIViC', 'Open Targets'],
    termsUrl: 'https://platform-docs.opentargets.org/licence',
    requiresNcbi: false
  },
  {
    id: 'structures',
    displayName: '结构与相互作用',
    description:
      '结构与分子相互作用——PDB 结构、AlphaFold 预测、EMDB 冷冻电镜条目、Complex Portal 复合物、IntAct 相互作用网络。',
    useWhen:
      'Use when you need a macromolecular 3D structure or a molecular interaction — experimental PDB entries (search, summaries, polymer entities, ligands), AlphaFold predicted models, EMDB cryo-EM metadata/validation, curated Complex Portal complexes, or IntAct binary interactions and networks.',
    sources: ['PDB', 'AlphaFold', 'EMDB', 'Complex Portal', 'IntAct'],
    termsUrl: 'https://www.rcsb.org/pages/usage-policy',
    requiresNcbi: false
  },
  {
    id: 'chembl',
    displayName: 'ChEMBL',
    description: '通过 ChEMBL REST API 获取生物活性化合物、药物、靶点、生物活性和作用机制。',
    useWhen:
      'Use for ChEMBL medicinal-chemistry data — search compounds by name, ChEMBL id, or molecular structure (similarity/substructure); find drugs by therapeutic indication with approval and withdrawal flags; get calculated ADMET / drug-likeness properties for a molecule; retrieve bioactivity measurements (IC50, Ki, EC50, pChEMBL) for compound-target pairs; look up mechanism of action; or search biological targets by gene symbol, name, organism, or type. Sourced from ChEMBL (EBI).',
    sources: ['ChEMBL'],
    termsUrl: 'https://chembl.gitbook.io/chembl-interface-documentation/about',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'biorxiv',
    displayName: 'bioRxiv',
    description:
      'bioRxiv/medRxiv 预印本——按日期/类别搜索、按 DOI 获取元数据、期刊发表链接、资助方列表和平台统计。',
    useWhen:
      'Use when working with bioRxiv or medRxiv preprints — searching by date range and category (no keyword search), fetching full metadata for a DOI, finding which preprints were published in journals (optionally by publisher DOI prefix), listing preprints by funder (ROR id), or reporting submission/usage statistics over time. Sourced from bioRxiv and medRxiv (funder ids via ROR).',
    sources: ['bioRxiv', 'medRxiv', 'ROR'],
    termsUrl: 'https://www.biorxiv.org/about/FAQ',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'drug_regulatory',
    displayName: '药物监管',
    description: '通过 openFDA 获取 Drugs@FDA 申请、标签和语料统计。',
    useWhen:
      'Use when you need FDA drug regulatory data — searching or fetching Drugs@FDA applications (NDA/ANDA/BLA) by brand, generic, ingredient, sponsor, marketing status, or pharmacologic class; aggregate/corpus statistics; generic equivalents of a brand; or product label (SPL) sections such as indications and boxed warnings. Sourced from openFDA (Drugs@FDA + drug labels).',
    sources: ['openFDA'],
    termsUrl: 'https://open.fda.gov/terms/',
    requiresNcbi: false
  },
  {
    id: 'human_genetics',
    displayName: '人类遗传学',
    description:
      '人类遗传关联证据——GWAS Catalog、eQTL Catalogue 和 PheWeb PheWAS 门户（FinnGen、BioBank Japan）。',
    useWhen:
      'Use when you need human genetic-association evidence — GWAS Catalog associations/studies/traits for a variant, gene or trait; eQTL Catalogue molecular-QTL datasets and associations; or PheWAS scans (variant- or gene-level) from FinnGen and BioBank Japan PheWeb portals.',
    sources: ['GWAS Catalog', 'eQTL Catalogue', 'PheWeb'],
    termsUrl: 'https://www.ebi.ac.uk/gwas/docs/about',
    requiresNcbi: false
  },
  {
    id: 'expression',
    displayName: '表达',
    description:
      '通过 GTEx 门户获取人类组织表达和 eQTL 数据；PanglaoDB 规范标记基因（离线）用于单细胞注释。',
    useWhen:
      'Use for GTEx tissue expression and eQTL evidence — listing tissue sites or dataset releases, resolving gene symbols to versioned GENCODE ids, median or per-sample expression (TPM) by tissue, top-expressed genes per tissue, sample/donor metadata, and cis-eQTLs (eGenes, single-tissue, multi-tissue METASOFT, or on-the-fly calculation) for a gene or variant. Sourced from GTEx. Also use for single-cell annotation — canonical marker genes per cell type (PanglaoDB set, offline) and reverse marker lookup.',
    sources: ['GTEx', 'PanglaoDB'],
    termsUrl: 'https://gtexportal.org/home/license',
    requiresNcbi: false
  },
  {
    id: 'protein_annotation',
    displayName: '蛋白质注释',
    description:
      '蛋白质结构域架构、家族/进化枝成员、表达图谱和相互作用网络——InterPro/Pfam、人类蛋白质图谱和 STRING。',
    useWhen:
      "Use when you need protein annotation — a protein's complete InterPro/Pfam domain architecture, entry/family/clan search and detail, member proteins or proteomes of a Pfam family, Human Protein Atlas per-gene expression (tissue/subcellular/pathology/blood/brain) and bulk search, or STRING id mapping, interaction networks and homology similarity. Sourced from InterPro, Pfam, the Human Protein Atlas and STRING.",
    sources: ['InterPro', 'Pfam', 'Human Protein Atlas', 'STRING'],
    termsUrl: 'https://string-db.org/cgi/access?footer_active_subpage=licensing',
    requiresNcbi: false
  },
  {
    id: 'cancer_models',
    displayName: '癌症模型',
    description: '通过 cBioPortal REST API 获取癌症基因组学研究记录；DepMap 癌细胞系依赖性评分。',
    useWhen:
      "Use when you need cancer genomics data from cBioPortal — listing or looking up cancer studies (cancer type, sample counts, citation), the mutations of a gene in a study (recurrent protein changes, mutation types), a gene's mutation frequency across several studies, discrete copy-number alterations (deletions/amplifications) of a gene, or a study's clinical attributes and survival endpoints. Also use for DepMap cancer dependency data — searching cancer cell lines and gene dependency scores (Chronos) across cell lines.",
    sources: ['cBioPortal', 'DepMap'],
    termsUrl: 'https://www.cbioportal.org/faq',
    requiresNcbi: false
  },
  {
    id: 'rna',
    displayName: 'RNA',
    description: '通过 Rfam 获取非编码 RNA 家族数据（元数据、比对、模型、结构）。',
    useWhen:
      'Use for non-coding RNA families from Rfam (accession or family id, e.g. RF00005 / tRNA): family metadata (RNA type, seed/full counts, gathering/trusted/noise cutoffs, clan); the seed alignment (Stockholm or FASTA); the Infernal covariance model; the seed phylogenetic tree; full-region hits across sequence databases; PDB structure mappings; accession<->id conversion; and single-sequence cmscan search against all Rfam models.',
    sources: ['Rfam'],
    termsUrl: 'https://docs.rfam.org/en/latest/',
    requiresNcbi: false
  },
  {
    id: 'omics_archives',
    displayName: '组学数据库',
    description:
      '组学数据档案——表达（ArrayExpress、GEO）、代谢组学（MetaboLights）、宏基因组学（MGnify）和蛋白质组学（PRIDE）。',
    useWhen:
      'Use when finding or looking up omics datasets across the major archives — functional-genomics / expression experiments in ArrayExpress (BioStudies) or NCBI GEO series (by keyword, organism, assay, or accession, with per-sample metadata); metabolomics studies and data files in MetaboLights (MTBLS); metagenomics studies and analyses in MGnify (MGYS, by free text or biome lineage); or proteomics projects and proteins in PRIDE Archive (PXD, by keyword/organism/instrument/disease, or protein↔project). Sourced from ArrayExpress, GEO, MetaboLights, MGnify and PRIDE.',
    sources: ['ArrayExpress', 'GEO', 'MetaboLights', 'MGnify', 'PRIDE'],
    termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
    requiresNcbi: true
  },
  {
    id: 'cellguide',
    displayName: 'CellGuide',
    description: '通过 CELLxGENE CellGuide 获取细胞类型身份、标记基因、来源数据集和组织。',
    useWhen:
      'Use for cell-type biology from CELLxGENE CellGuide — searching cell types by name/synonym, or (by Cell Ontology id or name) getting identity/description, computational or canonical marker genes, contributing source datasets/publications, and the anatomical tissues a cell type is found in.',
    sources: ['CELLxGENE'],
    termsUrl: 'https://cellxgene.cziscience.com/',
    requiresNcbi: false
  },
  {
    id: 'regulation',
    displayName: '基因调控',
    description:
      '基因调控功能基因组学——ENCODE 实验/生物样本/文件、JASPAR 转录因子结合谱和 UniBind ChIP-seq TFBS。',
    useWhen:
      'Use when you need gene-regulation / functional-genomics data — ENCODE experiments (ChIP-seq, ATAC-seq, ...), biosamples and data files (complete, count-verified searches by assay/target/organism/format, or a record by accession); JASPAR transcription-factor binding profiles (PFM by versioned matrix id, version history, filtered profile catalog by species/collection, and the species/taxa/collections/releases listings); or UniBind high-confidence TF binding sites (search ChIP-seq datasets, per-model TFBS detail with BED/FASTA URLs, and TFBS overlapping a genomic region). Sourced from ENCODE, JASPAR and UniBind.',
    sources: ['ENCODE', 'JASPAR', 'UniBind'],
    termsUrl: 'https://www.encodeproject.org/about/data-use-policy/',
    requiresNcbi: false
  },
  {
    id: 'research_resources',
    displayName: '研究资源',
    description: '资助机会搜索（Grants.gov）和抗体目录查询（Antibody Registry）。',
    useWhen:
      'Use when you need U.S. federal funding opportunities from Grants.gov (search by keyword, opportunity number, CFDA/ALN, agency such as NIH/NSF/FDA, status, eligibility, or funding category — complete, count-verified, with facet breakdowns) or research antibodies from the Antibody Registry (full-text search by target/name/catalog, lookup by RRID/accession, exact catalog-number matching, and registry statistics — with RRID, vendor, target, clone, and species). Sourced from Grants.gov and the Antibody Registry.',
    sources: ['Grants.gov', 'Antibody Registry'],
    termsUrl: 'https://www.antibodyregistry.org/',
    requiresNcbi: false
  },
  {
    id: 'biomart',
    displayName: 'BioMart',
    description: 'Ensembl BioMart 属性查询和标识符转换。',
    useWhen:
      'Use when you need Ensembl BioMart data — browsing the marts → datasets → attributes/filters hierarchy, running attribute queries (get_data) for a dataset with filters, or translating gene/transcript identifiers between attribute types (e.g. HGNC symbol → Ensembl gene ID).',
    sources: ['Ensembl BioMart'],
    termsUrl: 'https://www.ensembl.org/info/about/legal/disclaimer.html',
    requiresNcbi: false
  },
  {
    id: 'zinc',
    displayName: 'ZINC',
    description:
      'ZINC22 可购买化学空间（CartBlanche22）——按 ZINC ID 查询化合物、SMILES 精确/相似度搜索、供应商代码解析、随机采样、用于对接的 3D 结构定位。',
    useWhen:
      'Use when you need purchasable small molecules from ZINC22 — look up compounds by ZINC id, search by SMILES (exact or analog/similarity), resolve vendor catalog codes, draw a random compound sample, or locate docking-ready 3D structures. Sourced from ZINC22 / CartBlanche22.',
    sources: ['ZINC'],
    termsUrl: 'https://zinc.docking.org/',
    requiresNcbi: false
  }
]
