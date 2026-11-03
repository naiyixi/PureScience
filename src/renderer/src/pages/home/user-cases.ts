// The user-case model: what turns a project on this machine into a *case* with a name of its own.
//
// Two rules decide everything here, and both exist because the alternative is a lie:
//
//  1. **A case is named for what it contains, never for the folder it came from.** The project name is
//     what the user typed into a dialog; a case title is what the work turned out to be. So a curated
//     title wins, then the project's own description, then the most descriptive artifact filename — and
//     any candidate that merely repeats the project name is rejected by name, not by hope.
//  2. **Standing is earned by files, not by a session existing.** A case is `reproducible` only when the
//     artifacts on disk would let someone else re-run the work: enough of them, and more than one kind.
//     Anything less is `conversation-only`, said in words, and never dressed up as a case study.
//
// Everything in this module is pure so the rules can be tested on their own; the component reads stores.

export type CaseDomain = 'structure' | 'omics' | 'literature' | 'clinical' | 'general'

export const CASE_DOMAINS: readonly CaseDomain[] = [
  'structure',
  'omics',
  'literature',
  'clinical',
  'general'
] as const

export type CaseFootprint = {
  /** Sessions that ran in this project (the home rule: no session, no case). */
  sessions: number
  artifactCount: number
  uploadCount: number
  /** Files the case would hand over, as the Files catalogue counts them. */
  fileCount: number
  totalBytes: number
  /** Distinct file kinds, lower-case extensions, e.g. ['csv', 'md', 'png', 'py']. */
  kinds: string[]
}

/**
 * What makes a case *reproducible* rather than merely discussed: at least this many artifacts, and at
 * least this many distinct kinds among them. Six files of one kind is one artifact copied six times; six
 * files across three kinds is a report, its data and its figure — something a reader can check.
 */
export const CASE_MINIMUMS = { artifacts: 6, kinds: 3 } as const

export type CaseStanding = 'reproducible' | 'conversation-only'

export type CaseFile = {
  name: string
  size: number
  kind: string
}

export type UserCase = {
  projectId: string
  /** The case's own name. Never the project name unless a curator typed it there on purpose. */
  name: string
  nameSource: 'curated' | 'derived'
  domain: CaseDomain
  standing: CaseStanding
  footprint: CaseFootprint
  /** Milliseconds; absent when the app holds no timestamp — the card then says "ran here" instead. */
  lastActive?: number
  /** Newest-first, capped by the caller; used by the detail panel and by name derivation. */
  files: CaseFile[]
}

/**
 * Case titles curated on the machine this build ships from, keyed by project id. A curated title is a
 * judgement about the work ("this is the EGFR selectivity audit"), so it is not derived and not
 * translated. Projects without an entry fall through to `deriveCaseName`; nothing breaks off-machine.
 */
export const CURATED_CASE_TITLES: Readonly<Record<string, string>> = {
  // Named from what each project actually delivered (its own figures and reports), never from the folder
  // it lives in: these are the cases the Files catalogue can hand over in full.
  cmuh0axy50000jt29bqjmk9gm: 'GPCR 激活途径：采样收敛与滞后审计',
  cmu8lto2e0000wf7632agsbc4: '激酶 DFG 翻转：自由能景观与亚稳阱',
  cmu774nf00009wf1thr0smews: 'pH 开关抗体：内体捕获与沉没效应',
  cmtu8uuzw0003jtvngmoxthb0: 'III 期、CMC 与标志物同时爆雷：五模块复盘',
  cmtyf335n0002wfoqwwuw25j3: 'MEF2C 合成致死：24 个月执行方案',
  cmtylcgzj0002wfprhrknr3hv: 'c-Myc 变构口袋：从头设计与 PROTAC 库',
  cmtv1eh3c0003wft07lbd51t6: '单细胞暗物质：HCC 稀有细胞到合成致死',
  cmtux27u60001wft0tbgj4a7s: '零号病人：多组学异常到首次人体试验',
  cmtuc9z500000wft0otm9ub6t: 'PD-1/VEGF 双抗：上市后四重地狱',
  cmtuyzk4x0002wft0q9qxa604: '体内 CAR-T：自适应平台与实时制造',
  cmtu6j0lo0002jtvnq690hiz8: '追踪耐药 2.0：PDX 到 IND 放行',
  cmttkxm1b0001jtvnmn9t44ec: 'USP28 不可成药靶点：从口袋到专利',
  cmtpmhryz0001wfrerrndzkyl: '凝聚体药物：临界分配塌陷判定',
  cmtogmn0a0002jtx0h3bhdx8x: '抗体成熟：上位性冻结与构象熵陷阱',
  cmtoe8qbd0000jtx0nimtbra7: '冻干制剂：反玻璃化与水合壳渗流',
  cmtnz88670001jtrsk5lvyw8t: 'mRNA-LNP：内体逃逸的几何受阻判定',
  cmtny96w20000jtrstpqj5bpu: '共价抑制剂：二次活化与跨室相移',
  cmtn4f4qz0000jt5mf74x3ene: '铁死亡胶质瘤：森林图的假阳性清洗',
  cmvpaw0gl0000wf7idiw1i6x4: '2753 化合物的虚拟筛选与口袋复核',
  cmv84ss3h0000wf1qkjy93i3c: '创新药死亡谷：闸口评分与四级验证',
  cmv0zlg6t0000wfywoptl3ob3: '纳米抗体人源化：热点验证与表位重叠',
  cmutflcqb000fwfm931kvwz21: '早期成药性：降解杂质分级与晶型风险',
  cmus6s5yx0019wf4q78404kgu: 'IPF 双数据集复现 + CDK2 选择性筛选',
  cmvmc3kf90000jtunzjjojk8g: '共价对接与水判据：Mpro / p53-MDM2',
  cmvnzwek40000wf4akvm51rf7: '增强采样势垒与 FEP 误差审计（KcsA）',
  cmv7yb8m70000wfn52x7lvslq: '伞形采样滞后与 PMF 回线（GPCR）',
  cmt31dz5c0005wfeiv2aqqmsv: 'EGFR TKI 选择性审计：三库交叉热图',
  cmt35kjkc0007wfeih2w2hc3r: '论文 Fig6b 复现：主分支与反证分支',
  cmt2gdhp30002wfeit0evdkoy: '论文火山图复算：数值级一致性',
  cmt1md36t0001jt4lggg97q31: 'PBMC 单细胞：批次校正与双细胞筛查',
  cmt4dgs4u0001jty8ila5kkxe: '环境重建与产物代码复跑对照',
  cmt9xh6tn0000jtb04cq2f5ha: 'GFP 从头设计：自一致性与逆折叠'
}

/** Filenames that carry no subject: a case named "report" or "overview" says nothing about the work. */
const GENERIC_STEMS = new Set([
  'report',
  'summary',
  'overview',
  'figure',
  'figures',
  'result',
  'results',
  'output',
  'outputs',
  'index',
  'data',
  'readme',
  'main',
  'plot',
  'table',
  'analysis',
  'final'
])

/** Keyword tables for domain classification: strongest signal first, extension last. */
const DOMAIN_KEYWORDS: ReadonlyArray<{ domain: CaseDomain; pattern: RegExp }> = [
  {
    domain: 'omics',
    pattern:
      /\.(h5ad|h5|loom|mtx)$|gse\d|limma|deseq|umap|celltype|marker|doublet|single[-_ ]?cell|batch[-_ ]?effect|scrna/i
  },
  {
    domain: 'structure',
    pattern:
      /\.(pdb|cif|mol2?|sdf|fasta|fa|pdbqt|xtc|dcd|gro|prmtop)$|dock|pocket|pose|ligand|protein|antibody|vhh|epitope|pmf|umbrella|fep|msm|md[-_ ]?sim|retro|inverse[-_ ]?fold/i
  },
  {
    domain: 'literature',
    pattern:
      /\.(bib|ris|enw)$|citation|provenance|reproduc|paper[-_ ]?fig|volcano|screening|reference|zotero/i
  },
  {
    domain: 'clinical',
    pattern: /clinical|trial|ind_|ctd|patient|cohort|toxicit|efficacy|regulatory|dossier/i
  }
]

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Distinct lower-case extensions, stable order, capped so a 40-extension case stays readable. */
export const collectKinds = (filenames: readonly string[]): string[] => {
  const seen = new Set<string>()
  for (const name of filenames) {
    const kind = extensionOf(name)
    if (kind) seen.add(kind)
  }
  return [...seen].sort().slice(0, 12)
}

export const classifyDomain = (filenames: readonly string[]): CaseDomain => {
  const joined = filenames.join('\n')
  for (const { domain, pattern } of DOMAIN_KEYWORDS) {
    if (pattern.test(joined)) return domain
  }
  return 'general'
}

const stripExtension = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** `mtx_4dfr_report` → `mtx 4dfr report`; wording is left alone, only separators are normalised. */
export const humanizeStem = (name: string): string => {
  const words = stripExtension(name).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

// A description only names a case when it reads like a subject. Most of this machine's projects were
// created from a pasted task briefing ("任务背景（…）您是某 biotech 的研发负责人…"), and using that as the
// card title would put a paragraph of instructions where a case name belongs — so briefings are rejected
// outright rather than truncated into something that still reads like an order.
const DESCRIPTION_LABEL =
  /^(任务背景|背景|考核深度|考核|设定|目标|要求|情境)\s*[（(][^）)]{0,40}[）)]\s*[:：]?\s*/
const DESCRIPTION_IMPERATIVE =
  /你是|您的|你的|请您|请完成|请以|扮演|假设你|要求完成|考核深度|输出格式|不得/

const firstClause = (text: string, limit = 32): string => {
  const normalised = text.replace(/\s+/g, ' ').trim()
  if (!normalised) return ''
  const stripped = normalised.replace(DESCRIPTION_LABEL, '').trim()
  if (!stripped || DESCRIPTION_IMPERATIVE.test(stripped)) return ''
  const cut = (stripped.split(/[。；;！!？?\n]/)[0] ?? stripped).trim()
  if (!cut || cut.length > limit) return ''
  return cut
}

/** The most descriptive filename stem in the case — longest wins, generic stems are skipped. */
const descriptiveStem = (filenames: readonly string[]): string => {
  let best = ''
  for (const name of filenames) {
    const stem = humanizeStem(name)
    if (!stem || GENERIC_STEMS.has(stem.toLowerCase())) continue
    if (/^(fig|figure|plot|table)[_ -]?\d/i.test(stem)) continue
    if (stem.length > best.length) best = stem
  }
  return best.length >= 6 ? best : ''
}

const normaliseForCompare = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The case's own name. Order: curated title → project description → most descriptive artifact filename.
 * Any candidate that is just the project name again is skipped: the whole point is that the case is not
 * the folder. Returns '' when nothing qualifies, and the caller renders its own "untitled case" copy.
 */
export const deriveCaseName = (input: {
  projectId: string
  projectName: string
  description?: string
  files: readonly string[]
}): { name: string; source: 'curated' | 'derived' } => {
  const curated = CURATED_CASE_TITLES[input.projectId]
  if (curated && curated.trim()) return { name: curated.trim(), source: 'curated' }

  const projectName = normaliseForCompare(input.projectName)
  const candidates = [firstClause(input.description ?? ''), descriptiveStem(input.files)]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (normaliseForCompare(candidate) === projectName) continue
    return { name: candidate, source: 'derived' }
  }
  return { name: '', source: 'derived' }
}

export const judgeStanding = (footprint: CaseFootprint): CaseStanding =>
  footprint.artifactCount >= CASE_MINIMUMS.artifacts &&
  footprint.kinds.length >= CASE_MINIMUMS.kinds
    ? 'reproducible'
    : 'conversation-only'

/** Reproducible cases first; inside a tier, the most recently active; ties keep project-name order. */
export const sortCases = (cases: readonly UserCase[]): UserCase[] =>
  [...cases].sort((left, right) => {
    const rank = (item: UserCase): number => (item.standing === 'reproducible' ? 0 : 1)
    if (rank(left) !== rank(right)) return rank(left) - rank(right)
    const byActivity = (right.lastActive ?? 0) - (left.lastActive ?? 0)
    if (byActivity !== 0) return byActivity
    return left.name.localeCompare(right.name)
  })

/** Search covers the name the reader sees, the domain and every filename the case would hand over. */
export const matchesQuery = (item: UserCase, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (item.name.toLowerCase().includes(needle)) return true
  if (item.domain.toLowerCase().includes(needle)) return true
  return item.files.some((file) => file.name.toLowerCase().includes(needle))
}

export const filterCases = (
  cases: readonly UserCase[],
  filter: { query?: string; domain?: CaseDomain | 'all' }
): UserCase[] => {
  const query = filter.query ?? ''
  const domain = filter.domain ?? 'all'
  return cases.filter(
    (item) => (domain === 'all' || item.domain === domain) && matchesQuery(item, query)
  )
}

/** Bytes for a card line: one decimal, and never a fabricated 0 when the catalogue read nothing. */
export const formatCaseBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}
